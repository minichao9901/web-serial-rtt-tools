#!/usr/bin/env python3
"""kingst_la.py —— 金沙滩逻辑分析仪（KingstVIS Socket API）**单文件**工具：采集 + 离线分析 + SWD 解码

> 本文件是 `资料` 之外唯一需要的 LA 工具：**只用 Python 标准库**，拷走这一个文件就能用。
> 它同时也是《逻辑分析仪攻略.md》§11 里内嵌的那份源码 —— 只要带着那份 md，就能重建本文件。

为什么需要它：调位时序（SWD/UART/SPI…）必须看**真实波形**（周期/占空比/建立时间/采样点），
靠"猜 + 让人截图"太慢。KingstVIS 自带 Socket API（TCP 23367），本工具直接说这个协议。

一次性准备（`%LOCALAPPDATA%\\kingst\\vis.config`，改完**必须重启 KingstVIS**）：
    <enaSocket>1</enaSocket>   <listenPort>23367</listenPort>
    （默认模板是空标签 `<enaSocket/>` = 没启用，这就是"连不上"的第一嫌疑）

子命令：
    info                                    看采样率/状态/last-error
    stop                                    停掉"武装了但没触发"的采集（否则后面全部 NAK）
    analyzers                               列出 GUI 里已挂的协议解析器（= --analyzer 序号）
    decoded --out <csv> [--analyzer N|--dll SWD|--all] [--max N] [--grep 关键字]
                                            导出 **VIS 内置解析器**的解码结果并摘要
                                            （SWD/QSPI/SPI/I2C/SDIO/MIPI-DSI/I2S/USB1.1/PWM/WS2812…
                                             解析器只能在 GUI 里先挂好，见 §5 注释）
    export  --out <csv> [--channels ...] [--time-span a [b]] [--no-kvdat]
                                            把 VIS **当前 buffer** 导出（不重新采集），可只导兴趣窗口
    capture --rate --depth --channels --trigger --out [--time --threshold --timeout]
            [--time-span a [b]] [--no-kvdat] [--simulate] [--force]
                                            采集并导出跳变 CSV（阻塞到采完）；默认顺带存 .kvdat 原始档
    stats   <csv>                           每通道跳变数/上升沿/高低均值
    freq    <csv>                           突发内位周期/频率/占空比（排除主机往返的空隙）
    burst   <csv>                           时钟占空比 + 每段突发时长/拍数/折算字数
    detail  <csv>                           逐拍周期 + DIO 跳到 CLK 沿的偏移（采样点该等多久）
    decode  <csv>                           按事务解 SWD（包头/turnaround/ACK/数据/校验）
    list    <csv>                          打印原始跳变（排查"到底有没有波形"）

典型用法（**别赌触发**）：
    ① `capture` 后台跑（阻塞等触发）→ ② 另一边跑流量（见攻略 §4 的流量发生器）→ ③ 采集自动结束
    采不到波形时先怀疑"流量已经跑完"或"上一次采集还武装着"（先 `stop`）。
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import socket
import statistics
import sys
import time
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HOST = os.environ.get("KINGSTVIS_HOST", "127.0.0.1")
PORT = int(os.environ.get("KINGSTVIS_PORT", "23367"))
IDLE_GAP = 0.5          # 读到"半秒没新数据"就算这一条响应读完了（协议没有结束符）


# ======================================================================
#  1. Socket API 客户端
# ======================================================================
class Vis:
    """KingstVIS Socket API：纯文本命令 + `ACK`/`NAK` 应答，**没有结束符**，
    靠"空闲 0.5s"判断读完。NAK 时顺手读 get-last-error 把原因带出来。"""

    def __init__(self, host=HOST, port=PORT):
        try:
            self.sock = socket.create_connection((host, port), timeout=5.0)
        except OSError as e:
            raise ConnectionError(
                f"连不上 KingstVIS（{host}:{port}）：{e}\n"
                "  ① KingstVIS 开着吗？（进程没了就是这个报错）\n"
                "  ② vis.config 里 <enaSocket>1</enaSocket> 改过并**重启**过吗？") from None

    def cmd(self, text: str, timeout: float = 15.0) -> str:
        self.sock.settimeout(timeout)
        self.sock.sendall(text.encode("utf-8"))
        buf = b""
        while True:
            try:
                chunk = self.sock.recv(4096)
            except socket.timeout:
                if not buf:
                    raise
                break
            if not chunk:
                break
            buf += chunk
            self.sock.settimeout(IDLE_GAP)
        raw = buf.decode("utf-8", "replace").strip()
        if raw.startswith("NAK"):
            try:
                err = self.cmd("get-last-error")
            except Exception:                       # noqa: BLE001
                err = "(读不到)"
            raise RuntimeError(f"{text.split()[0]} -> NAK  {err}")
        return raw[3:].strip() if raw.startswith("ACK") else raw

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


# ======================================================================
#  2. CSV（跳变列表）解析
# ======================================================================
def parse_csv(path: str):
    """返回 (初始电平, 每通道跳变表, 通道号列表)。

    🚨 三个坑（第一版把 0xA5 解成过 0xCC / 0xD2 / 0x25）：
      ① 每行给的是**该时刻所有通道**的电平，不是只有变化的那个 → 必须按通道去重；
      ② **第 0 行是窗口起点的初始电平，不是跳变**；
      ③ 取电平时初值必须用**该通道的初始电平**（见 level_at）。
    """
    tracks: dict[int, list[tuple[float, int]]] = {}
    chans: list[int] = []
    init: dict[int, int] = {}
    with open(path, newline="", encoding="utf-8-sig", errors="replace") as f:
        reader = csv.reader(f)
        header = next((r for r in reader if r), None)
        if not header:
            raise ValueError(f"{path} 是空文件 —— 采集那一步没导出成功（常见：NAK/超时）")
        for i, name in enumerate(header[1:]):
            digits = "".join(ch for ch in name if ch.isdigit())
            chans.append(int(digits) if digits else i)
        for row in reader:
            if not row or not row[0].strip():
                continue
            try:
                t = float(row[0])
            except ValueError:
                continue
            for i, cell in enumerate(row[1:]):
                c = cell.strip()
                if c not in ("0", "1"):
                    continue
                ch, lv = chans[i], int(c)
                if ch not in init:
                    init[ch] = lv                  # ① 初始电平，不是跳变
                    continue
                if lv != init[ch] and (not tracks.get(ch) or tracks[ch][-1][1] != lv):
                    tracks.setdefault(ch, []).append((t, lv))
                    init[ch] = lv                  # ② 只记真正变化
    return init, tracks, chans


def level_at(track, t, init_level=0):
    """t 时刻的电平。🚨 初值必须传该通道的初始电平，默认 0 会把"第一次跳变之前"读错。"""
    lv = init_level
    for tt, l in track:
        if tt > t:
            break
        lv = l
    return lv


def rising_edges(track):
    return [t for t, lv in track if lv == 1]


def high_durations(track):
    """所有**完整高电平段**的时长（秒）。
    🚨 别用 `zip(上升沿, 下降沿)` 配对：抓包若从高电平开始（初始电平=1），
       fall[0] 在 rise[0] 之前，整个 zip 就整体错位、全部配成负数 → 占空比算出来是空的。"""
    out = []
    prev_t = prev_lv = None
    for t, lv in track:
        if prev_lv == 1 and lv == 0:
            out.append(t - prev_t)
        prev_t, prev_lv = t, lv
    return out


def low_durations(track):
    out = []
    prev_t = prev_lv = None
    for t, lv in track:
        if prev_lv == 0 and lv == 1:
            out.append(t - prev_t)
        prev_t, prev_lv = t, lv
    return out


def stats(track, ch, name=""):
    if not track:
        print(f"  CH{ch:<2} {name:<10} 无跳变（一直不变）")
        return
    high = low = 0.0
    nh = nl = 0
    cur_lv, cur_t = track[0][1], track[0][0]
    for t, lv in track[1:]:
        d = t - cur_t
        if cur_lv == 1:
            high += d
            nh += 1
        else:
            low += d
            nl += 1
        cur_lv, cur_t = lv, t
    r = rising_edges(track)
    span = r[-1] - r[0] if len(r) > 1 else 0.0
    line = (f"  CH{ch:<2} {name:<10} 跳变 {len(track):>7}  上升沿 {len(r):>7}  "
            f"频率 {(len(r)/span/1e6) if span > 0 else 0:8.3f} MHz")
    if nh and nl:
        line += f"  高均值 {high/nh*1e9:7.1f} ns  低均值 {low/nl*1e9:7.1f} ns"
    print(line)


# ======================================================================
#  3. 分析：位周期 / 占空比 / 逐拍 / 采样点偏移
# ======================================================================
def intra_burst(track, gap_ns):
    """把上升沿间隔切成"突发内"(<gap) 和"突发间"(>=gap)，返回 (突发段列表, 突发内间隔)。"""
    r = rising_edges(track)
    if len(r) < 2:
        return [], []
    iv = [(r[i + 1] - r[i]) * 1e9 for i in range(len(r) - 1)]
    bursts, cur = [], [r[0]]
    for i, d in enumerate(iv):
        if d >= gap_ns:
            bursts.append(cur)
            cur = []
        cur.append(r[i + 1])
    bursts.append(cur)
    return bursts, [d for d in iv if d < gap_ns]


def cmd_freq(init, tracks, a):
    clk = tracks.get(a.ch_clk, [])
    thr = a.gap * 1e9 * 5
    bursts, intra = intra_burst(clk, thr)
    if not intra:
        print(f"CLK 上升沿只有 {len(rising_edges(clk))} 个 —— 没有波形（先怀疑流量跑完/采集还武装着）")
        return 1
    med = statistics.median(intra)
    hi = [d * 1e9 for d in high_durations(clk) if 0 < d * 1e9 < thr]
    lo = [d * 1e9 for d in low_durations(clk) if 0 < d * 1e9 < thr]
    print(f"  CLK 上升沿 {len(rising_edges(clk))} 个，突发 {len(bursts)} 段")
    print(f"  突发内位周期：中位 {med:7.1f} ns  最快 {min(intra):7.1f} ns"
          f"  → 中位 {1000.0/med:5.2f} MHz  峰值 {1000.0/min(intra):5.2f} MHz")
    if hi:
        print(f"  高电平中位 {statistics.median(hi):7.1f} ns  → 占空比约 {statistics.median(hi)/med*100:4.1f}%")
    if lo:
        print(f"  低电平中位 {statistics.median(lo):7.1f} ns（突发内的，不含事务之间的空隙）")
    return 0


def cmd_burst(init, tracks, a):
    clk = tracks.get(a.ch_clk, [])
    bursts, intra = intra_burst(clk, a.gap * 1e9 * 5)
    if not bursts:
        print("没有波形")
        return 1
    r = rising_edges(clk)
    busy = sum(b[-1] - b[0] for b in bursts)
    span = r[-1] - r[0]
    lens = [len(b) for b in bursts]
    print(f"  窗口 {span*1e6:.1f} us；突发 {len(bursts)} 段，合计 {busy*1e6:8.1f} us，"
          f"突发之间 {(span-busy)*1e6:8.1f} us")
    print(f"  → 时钟占空比 = {busy/span*100 if span else 0:5.1f}%  "
          f"（其余是主机 USB 往返/固件逐字开销，**不是**时钟）")
    print(f"  每段突发长度：中位 {statistics.median(lens):6.1f} 拍  最短 {min(lens)}  最长 {max(lens)}"
          f"（一笔 SWD 传输 = 12/13/46 拍）")
    if intra:
        med = statistics.median(intra)
        print(f"  突发内位周期：中位 {med:6.1f} ns（{1000.0/med:5.2f} MHz）"
              f"  → 若全程都按这个位周期，46 拍/字需要 {46*med/1000:6.2f} us/字")
    print("  逐段突发（时长 / 拍数 / 平均周期 / 折算字数）：")
    for b in bursts[:6]:
        dur = (b[-1] - b[0]) * 1e6
        if dur:
            print(f"    {dur:8.1f} us / {len(b):6d} 拍 / {dur*1000/len(b):5.1f} ns  "
                  f"≈ {len(b)/46:6.1f} 字  → {dur/(len(b)/46):5.2f} us/字")
    return 0


def cmd_detail(init, tracks, a):
    clk, dio = tracks.get(a.ch_clk, []), tracks.get(a.ch_dio, [])
    r, f = rising_edges(clk), [t for t, lv in clk if lv == 0]
    if len(r) < 12:
        print("时钟太少，看不出相位")
        return 1
    gap_ns = a.gap * 1e9 * 5
    bursts, _ = intra_burst(clk, gap_ns)
    best = max(bursts, key=len)
    idx = {t: i for i, t in enumerate(r)}
    seg = [(r[idx[best[i + 1]]] - r[idx[best[i]]]) * 1e9 for i in range(len(best) - 1)]
    print(f"  最长突发 {len(best)} 拍")
    print(f"  位周期：中位 {statistics.median(seg):.1f} ns（{1000/statistics.median(seg):.2f} MHz）"
          f"  最快 {min(seg):.1f}  最慢 {max(seg):.1f}")
    # DIO 跳变相对最近 CLK 沿的偏移 —— 回答"目标驱动 SWDIO 要多久 / 采样点能放多早"
    of, orr = [], []
    for t, _lv in dio:
        nf = min(f, key=lambda x: abs(x - t)) if f else None
        nr = min(r, key=lambda x: abs(x - t)) if r else None
        if nf is not None and abs(t - nf) * 1e9 < 200:
            of.append((t - nf) * 1e9)
        elif nr is not None and abs(t - nr) * 1e9 < 200:
            orr.append((t - nr) * 1e9)
    if of:
        pos = [o for o in of if o > 0]
        print(f"  DIO 跳变相对**下降沿**：{len(of)} 次，中位 {statistics.median(of):+6.1f} ns"
              f"（{min(of):+.1f} … {max(of):+.1f}）"
              + (f"；沿后为正的 {len(pos)} 次，中位 {statistics.median(pos):+.1f} ns，"
                 f"**最慢 {max(pos):+.1f} ns**" if pos else ""))
    if orr:
        print(f"  DIO 跳变相对**上升沿**：{len(orr)} 次，中位 {statistics.median(orr):+6.1f} ns"
              f"（{min(orr):+.1f} … {max(orr):+.1f}）")
    print("  前 48 拍周期：")
    for i in range(0, min(48, len(seg)), 12):
        print("    " + " ".join(f"{d:5.1f}" for d in seg[i:i + 12]))
    return 0


# ======================================================================
#  4. SWD 事务级解码
# ======================================================================
ACK_NAME = {1: "OK", 2: "WAIT", 4: "FAULT", 7: "NO-ACK(线被拉高/无响应)"}


def parse_frame(bits):
    """8 包头 + 1 turnaround + 3 ACK + 数据 + 校验。返回 (包头dict, ack, data, parity)。"""
    if len(bits) < 12:
        return None
    h = bits[0:8]
    out = {
        "byte": sum(b << i for i, b in enumerate(h)),
        "bits": "".join(map(str, h)),
        "start": h[0], "apndp": h[1], "rnw": h[2],
        "addr": (h[3] << 2) | (h[4] << 3),
        "par_ok": ((h[1] + h[2] + h[3] + h[4]) & 1) == h[5],
        "stop": h[6], "park": h[7],
    }
    ack = bits[9] | (bits[10] << 1) | (bits[11] << 2)
    data = par = None
    if ack == 1:
        if out["rnw"] and len(bits) >= 45:              # 读：12..43 数据，44 校验
            data = sum(b << i for i, b in enumerate(bits[12:44]))
            par = bits[44]
        elif not out["rnw"] and len(bits) >= 46:        # 写：12 turnaround，13..44 数据，45 校验
            data = sum(b << i for i, b in enumerate(bits[13:45]))
            par = bits[45]
    return out, ack, data, par


def cmd_decode(init, tracks, a):
    clk, dio = tracks.get(a.ch_clk, []), tracks.get(a.ch_dio, [])
    r = rising_edges(clk)
    if len(r) < 2:
        print("CLK 没有波形")
        return 1
    print(f"  CH{a.ch_clk}(CLK) 初始={init.get(a.ch_clk,0)} 跳变 {len(clk)}   "
          f"CH{a.ch_dio}(DIO) 初始={init.get(a.ch_dio,0)} 跳变 {len(dio)}")
    groups, cur = [], [r[0]]
    for t in r[1:]:
        if t - cur[-1] > a.gap:
            groups.append(cur)
            cur = []
        cur.append(t)
    groups.append(cur)
    print(f"  上升沿 {len(r)} 个，切成 {len(groups)} 笔事务（间隔阈值 {a.gap*1e6:.1f} us）")
    for gi, g in enumerate(groups[: a.max]):
        bits = [level_at(dio, t + 1e-12, init.get(a.ch_dio, 0)) for t in g]
        print(f"\n  ── 事务 #{gi}  {len(g)} 个时钟  t0={g[0]*1e6:+.3f} us  "
              f"平均周期 {(g[-1]-g[0])/max(1,len(g)-1)*1e9:.1f} ns")
        fr = parse_frame(bits)
        if fr is None:
            print(f"     位流 {''.join(map(str,bits))}")
            continue
        h, ack, data, par = fr
        print(f"     包头 {h['bits']} = 0x{h['byte']:02X}  start={h['start']} APnDP={h['apndp']} "
              f"RnW={h['rnw']} A=0x{h['addr']:02X} parity={'对' if h['par_ok'] else '❌错'} "
              f"stop={h['stop']} park={h['park']}")
        print(f"     ACK = {ack} ({ACK_NAME.get(ack,'?')})")
        e = [(t, lv) for t, lv in dio if g[7] < t <= g[min(11, len(g)-1)]]
        print(f"     ACK 期间 DIO 跳变 {len(e)} 次" + ("" if e else "  ← 一直没动"))
        if data is not None:
            print(f"     数据 = 0x{data:08X}  校验位={par}"
                  f"({'对' if (bin(data).count('1') & 1) == par else '❌错'})")
        print(f"     位流: {''.join(map(str,bits[:48]))}")
    if len(groups) > a.max:
        print(f"\n  ...（还有 {len(groups)-a.max} 笔未打印）")
    return 0


def cmd_list(init, tracks, a):
    ev = sorted([(t, f"CH{a.ch_clk}->{lv}") for t, lv in tracks.get(a.ch_clk, [])] +
                [(t, f"CH{a.ch_dio}->{lv}") for t, lv in tracks.get(a.ch_dio, [])])
    for i, (t, s) in enumerate(ev[: a.max]):
        print(f"    #{i:<4} {t*1e9:12.1f} ns  {s}")
    print(f"  （共 {len(ev)} 个跳变）")
    return 0


# ======================================================================
#  5. VIS 内置协议解析器（3.6.6 起可用）+ 导出 / 真数据防护
# ======================================================================
# 背景（2026-09-26 在 KingstVIS 3.6.6 上逐条实测确认，别凭印象改）：
#   · `export-decoded <file> [--analyzer N]` 把 GUI 里**已挂好的**协议解析器的解码结果
#     导成 .csv/.txt。解析器是插件 dll（本机 44 个）：SWD / JTAG / QSPI / SPI / I2C /
#     SDIO / MIPI-DSI / I2S / USB1.1 / PWM / RGBW-WS2812 … 正好覆盖本工作区在调的总线。
#     其中 SWD.dll 能解 ACK OK/WAIT/FAULT、请求/数据 parity、Line Reset、Turnaround、
#     DP/AP 寄存器名 —— 比本文件 §4 手写那套强（手写版仍然有用：全自动、无需 GUI 预挂）。
#   · 🚨 导出是**异步**的：路径不合法时命令**照样先回 ACK**，错误只在 `get-last-error`
#     里以 `save file failed` 出现 → 必须"等文件出现并稳定 + 比对 last-error 前后值"。
#   · 🚨 `get-last-error` 是**粘性**的（命令成功后不清零，仍是历史上最后一次错误）→
#     只能当"变化检测"用，不能当返回值用。
#   · ✅ `--analyzer N` 会校验：0→ACK；越界（1/2/5/99）→NAK + `invalid parameter`。
#   · 🚨 Socket API **没有**添加/配置解析器的命令（文档 14 条 + 未文档化的 save-data 都
#     没有）→ 解析器只能先在 GUI 里挂好；脚本能自动化的部分 = 读回配置知道序号 +
#     采完把结果导出来 + 摘要。100% 无人值守要"关 VIS → 改 vis.config → 启 VIS"（未验证）。
VIS_CONFIG = os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"),
                          "kingst", "vis.config")


def read_glitch_settings(path, rate=None):
    """读取 KVDAT 的采集设置快照；vis.config 只代表磁盘预设，可能落后于 GUI。"""
    if rate is not None and rate <= 0:raise ValueError('采样率必须大于零')
    with open(path, 'rb') as stream:
        header = stream.read(256 * 1024)
    end = header.find(b'</settings>')
    if end < 0:
        raise ValueError('没有完整的 Kingst settings 头（上限 256 KiB）')
    xml = header[:end + len(b'</settings>')]
    if str(path).lower().endswith('.kvdat'):
        import struct
        marker = header.find(b'kvdat\0\0\0', end)
        if marker < 0 or len(header) < marker + 40:raise ValueError('KVDAT 采样头不完整')
        depth, actual_rate = struct.unpack_from('<QQ', header, marker + 8)
        if not depth or not 0 < actual_rate <= 500000000:raise ValueError('不支持的 KVDAT 采样头')
        if rate is not None and rate != actual_rate:raise ValueError('指定采样率与 KVDAT 档案不一致')
        rate = actual_rate
    def field(name):
        match = re.findall(rb'<' + name + rb'>([^<]*)</' + name + rb'>', xml)
        if len(match) != 1:
            raise ValueError('Kingst 设置字段缺失或重复：' + name.decode())
        return match[0].decode('ascii').strip()
    values = [int(x) for x in field(b'glitchFilterSettings').rstrip(',').split(',')]
    if not values or len(values) % 2 or len(values) > 128:
        raise ValueError('不支持的毛刺过滤设置格式')
    channels = []
    for ch, (enabled, samples) in enumerate(zip(values[::2], values[1::2])):
        if enabled not in (0, 1) or samples < 0 or (enabled and samples < 1):
            raise ValueError('无效的毛刺过滤设置')
        item = dict(channel=ch, enabled=bool(enabled), samples=samples)
        if rate:
            if rate <= 0:raise ValueError('采样率必须大于零')
            item['widthNs'] = samples / rate * 1e9
        channels.append(item)
    mode = int(field(b'glitchFilterMode'))
    if mode not in (0, 1):raise ValueError('不支持的毛刺过滤保留模式')
    return dict(basis='record snapshot' if str(path).lower().endswith('.kvdat') else 'disk preset; live GUI may differ',
                source=str(path), keepOnRestart=bool(mode), channels=channels,
                sampleRate=rate, nativeSocketControl=False)


def glitch_preset_bytes(original, channels, samples=1, enabled=True, keep=True):
    """仅替换两个 ASCII 字段，保留 Kingst 文件中其它字节（包含本地编码）。"""
    matches = re.findall(rb'<glitchFilterSettings>([^<]*)</glitchFilterSettings>', original)
    if len(matches) != 1:raise ValueError('毛刺过滤字段缺失或重复')
    values = [int(x) for x in matches[0].strip().rstrip(b',').split(b',')]
    if not values or len(values) % 2:raise ValueError('不支持的过滤格式')
    if not channels or len(set(channels)) != len(channels):raise ValueError('通道不能为空或重复')
    if not isinstance(samples, int) or not 1 <= samples <= 999:raise ValueError('周期数范围为 1～999')
    for ch in channels:
        if ch < 0 or ch >= len(values)//2:raise ValueError('通道超出配置范围')
        values[ch*2:ch*2+2] = [int(enabled), samples]
    value = ','.join(map(str, values)).encode() + b','
    result = re.sub(rb'<glitchFilterSettings>[^<]*</glitchFilterSettings>',
                    b'<glitchFilterSettings>' + value + b'</glitchFilterSettings>', original)
    result, count = re.subn(rb'<glitchFilterMode>(?:0|1)</glitchFilterMode>|<glitchFilterMode\s*/>',
                           b'<glitchFilterMode>' + str(int(keep)).encode() + b'</glitchFilterMode>', result)
    if count != 1:raise ValueError('过滤保留模式字段缺失或重复')
    return result


def kingst_running():
    """预设只在启动时加载；Windows 上明确拒绝覆盖运行中 VIS 的配置。"""
    if os.name != 'nt':raise RuntimeError('应用预设目前只支持 Windows；可用 --out 生成副本')
    import subprocess
    result = subprocess.run(['tasklist', '/FI', 'IMAGENAME eq KingstVIS.exe', '/FO', 'CSV', '/NH'],
                            capture_output=True, check=True, creationflags=subprocess.CREATE_NO_WINDOW)
    return b'kingstvis.exe' in result.stdout.lower()


def cmd_glitch_preset(args):
    source = Path(args.config).resolve()
    original = source.read_bytes()
    # Validate observed format before changing any file.
    read_glitch_settings(source)
    changed = glitch_preset_bytes(original, args.channels, args.samples,
                                 enabled=not args.disable, keep=not args.reset_on_restart)
    if args.apply:
        if kingst_running():
            raise SystemExit('KingstVIS 仍在运行：请先正常退出，再应用预设；Socket API 不支持实时设置滤波。')
        import uuid
        backup = source.with_name(source.name + '.' + uuid.uuid4().hex[:8] + '.bak')
        with backup.open('xb') as stream:stream.write(original)
        import tempfile
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=source.parent, delete=False) as stream:
                temporary = Path(stream.name);stream.write(changed)
            os.replace(temporary, source)
        finally:
            if temporary and temporary.exists():temporary.unlink()
        print('已备份：', backup)
        print('预设已写入；下次启动 KingstVIS 后生效，尚未进行启动回读验收。')
    else:
        output = Path(args.out).resolve()
        if output == source:raise SystemExit('同路径写入请使用 --apply，并先正常退出 KingstVIS')
        with output.open('xb') as stream:stream.write(changed)
        print('已生成预设副本：', output, '；当前 KingstVIS 设置未修改。')
    return 0


def _safe_last_error(v) -> str:
    try:
        return v.cmd("get-last-error")
    except Exception:                               # noqa: BLE001
        return "(读不到)"


def list_analyzers() -> list[dict]:
    """读 vis.config 里**当前挂了哪些解析器** → [{index, dll, params, format}]。

    index 就是 `export-decoded --analyzer N` 的 N。
    ⚠️ VIS 退出时才回写这个文件，所以读到的可能比 GUI 里的现状旧一点。
    """
    import xml.etree.ElementTree as ET
    try:
        root = ET.parse(VIS_CONFIG).getroot()
    except Exception as e:                          # noqa: BLE001
        print(f"⚠️ 读不到 {VIS_CONFIG}（{e}）→ 解析器序号只能靠 --analyzer 盲试", file=sys.stderr)
        return []
    box = root.find(".//analyzers")
    if box is None:
        return []
    out = []
    for item in list(box):
        m = re.fullmatch(r"item(\d+)", item.tag)
        out.append({"index": int(m.group(1)) if m else None,
                    "dll": (item.findtext("fileName") or "").strip(),
                    "params": (item.findtext("parameters") or "").strip(),
                    "format": (item.findtext("format") or "").strip()})
    out.sort(key=lambda a: (a["index"] is None, a["index"]))
    return out


def pick_analyzer(name: str) -> int:
    """按 dll 名挑序号：`--dll SWD` → SWD.dll 的 index。"""
    want = name.lower().removesuffix(".dll")
    anas = list_analyzers()
    for a in anas:
        if a["index"] is not None and a["dll"].lower().removesuffix(".dll") == want:
            return a["index"]
    for a in anas:
        if a["index"] is not None and want in a["dll"].lower():
            return a["index"]
    have = ", ".join(f"{a['index']}:{a['dll']}" for a in anas) or "（一个都没挂）"
    raise SystemExit(f"vis.config 里没有匹配 {name!r} 的解析器。已挂的：{have}\n"
                     "  解析器只能在 KingstVIS GUI 里挂（Socket API 没这个命令）")


def wait_for_file(path: str, timeout: float = 20.0, stable: int = 2) -> bool:
    """等异步写落地：文件出现 **且** 大小连续 stable 次（每次 0.2s）不变。"""
    t0, last, same = time.time(), -1, 0
    while time.time() - t0 < timeout:
        if os.path.exists(path):
            sz = os.path.getsize(path)
            if sz == last:
                same += 1
                if same >= stable:
                    return True
            else:
                same = 0
            last = sz
        time.sleep(0.2)
    return os.path.exists(path) and os.path.getsize(path) > 0


def export_decoded(v, out: str, analyzer=None) -> str:
    """导出某个解析器的解码结果。**先 ACK 不代表写成功** → 这里等文件 + 查 last-error。"""
    err0 = _safe_last_error(v)
    if os.path.exists(out):
        os.remove(out)
    v.cmd(f'export-decoded "{out}"' + (f" --analyzer {analyzer}" if analyzer is not None else ""))
    ok = wait_for_file(out)
    err1 = _safe_last_error(v)
    if not ok:
        raise SystemExit(f"export-decoded 没落地：{out}\n  get-last-error: {err1}")
    if err1 != err0:
        raise SystemExit(f"导出期间 VIS 报错：{err1}")
    return out


def do_export(v, out: str, channels=None, time_span=None, kvdat=True):
    """把 VIS **当前 buffer** 导成跳变 CSV（可选 --chn-select / --time-span），
    并按需存一份 .kvdat 原始档（`save-data` 文档没写但实测可用；失败只警告）。"""
    sel = (" --chn-select " + " ".join(str(c) for c in channels)) if channels else ""
    span = (" --time-span " + " ".join(str(x) for x in time_span)) if time_span else ""
    if os.path.exists(out):
        os.remove(out)
    v.cmd(f'export-data "{out}"{sel}{span}', timeout=120)
    if not wait_for_file(out, timeout=120):
        raise RuntimeError(f"export-data 没落地：{out}\n  get-last-error: {_safe_last_error(v)}")
    kv = None
    if kvdat:
        kv = os.path.splitext(out)[0] + ".kvdat"
        try:
            v.cmd(f'save-data "{kv}"', timeout=120)
            wait_for_file(kv, timeout=120)
            kv = kv if os.path.exists(kv) else None
            if kv:
                print(f"  .kvdat 原始档: {kv}（可在 KingstVIS 里直接打开）")
                try:
                    settings = read_glitch_settings(kv, int(v.cmd('get-sample-rate')))
                    Path(out + '.la.json').write_text(json.dumps(settings, ensure_ascii=False, indent=2), encoding='utf8')
                except Exception as e:
                    print(f"  （滤波设置快照未读取：{e}）")
        except Exception as e:                      # noqa: BLE001
            print(f"  （.kvdat 存档跳过：{e}）")
    return out, kv


def summarize_decoded(path: str, max_rows: int = 20, grep: str = "") -> None:
    """打印解码结果摘要：帧数 / 按类型计数 / 异常帧 / 前 N 帧。"""
    with open(path, newline="", encoding="utf-8-sig", errors="replace") as f:
        rows = list(csv.reader(f))
    if not rows:
        print("  （文件是空的）")
        return
    head = rows[0]
    body = [r for r in rows[1:] if any(c.strip() for c in r)]
    print(f"  表头 : {', '.join(head)}")
    print(f"  帧数 : {len(body)}（文件 {os.path.getsize(path)} B）")
    if not body:
        print("  ⚠️ 只有表头 = 这段波形里没有可解内容。按顺序查三件事：")
        print("     ① 解析器的**通道映射**和实际接线对得上吗（GUI 里点开解析器看它选的是哪几路）")
        print("     ② 波形里真有该协议吗（先 list / decode 看有没有跳变）")
        print("     ③ 解析器刚挂上的话，重新采一次再导最稳（对挂载前的老 buffer 是否回溯解码未逐条验证）")
        return
    for col in ("Type", "ACK"):
        if col in head:
            i = head.index(col)
            cnt: dict[str, int] = {}
            for r in body:
                k = (r[i].strip() if i < len(r) else "") or "(空)"
                cnt[k] = cnt.get(k, 0) + 1
            top = sorted(cnt.items(), key=lambda x: -x[1])[:8]
            print(f"  按 {col} 统计: " + ", ".join(f"{k}={n}" for k, n in top))
    errs = [r for r in body
            if any(w in " ".join(r) for w in ("FAULT", "WAIT", "Parity", "Error", "error"))]
    if errs:
        print(f"  ⚠️ 含异常关键字的帧 {len(errs)} 条（FAULT/WAIT/Parity/Error），前 3 条：")
        for r in errs[:3]:
            print("     " + " | ".join(r))
    show = [r for r in body if (not grep or grep.lower() in " ".join(r).lower())][:max_rows]
    print(f"  前 {len(show)} 帧" + (f"（--grep {grep!r}）" if grep else "") + ":")
    widths = [max([len(head[i])] + [len(r[i]) for r in show if i < len(r)])
              for i in range(len(head))]
    for r in show:
        cells = [(r[i] if i < len(r) else "") for i in range(len(head))]
        print("     " + "  ".join(c.ljust(widths[i]) for i, c in enumerate(cells)).rstrip())


def cmd_analyzers() -> int:
    """列出 GUI 里已挂的解析器（不需要连 VIS，只读 vis.config）。"""
    anas = list_analyzers()
    if not anas:
        print(f"vis.config 里没有已挂的解析器（或读不到 {VIS_CONFIG}）。")
    else:
        print(f"已挂解析器（读自 {VIS_CONFIG}）:")
        for a in anas:
            print(f"  --analyzer {a['index']}  {a['dll']:<22}"
                  f"params={a['params'] or '-'}  format={a['format'] or '-'}")
    print("\n🚨 Socket API **不能**添加/配置解析器（文档 14 条命令 + 未文档化的 save-data 都没有）：")
    print("   在 KingstVIS GUI 的『协议解析器』面板里添加 → 选 SWD / QSPI / SPI / I2C… → 指定通道与参数。")
    print("   挂好之后：decoded --out dec.csv --dll SWD （或 --analyzer N / --all）")
    return 0


def cmd_decoded(v, args) -> int:
    """导出 VIS 内置解析器的解码结果并摘要。"""
    if args.all:
        idxs = [a["index"] for a in list_analyzers() if a["index"] is not None]
        if not idxs:
            raise SystemExit("读不到解析器列表，--all 无从下手（改用 --analyzer N）")
    elif args.dll:
        idxs = [pick_analyzer(args.dll)]
    elif args.analyzer is not None:
        idxs = [args.analyzer]
    else:
        idxs = [0]                                  # 与 VIS 默认一致：不带 --analyzer 就是第一个
    base = args.out or os.path.join(os.getcwd(), "kingst_decoded.csv")
    anas = {a["index"]: a for a in list_analyzers()}
    for idx in idxs:
        out = base if len(idxs) == 1 else f"{os.path.splitext(base)[0]}_{idx}.csv"
        print(f"== 解析器 #{idx}（{(anas.get(idx) or {}).get('dll', '?')}）→ {out}")
        export_decoded(v, out, idx)
        summarize_decoded(out, max_rows=args.max, grep=args.grep)
    return 0


def cmd_export(v, args) -> int:
    """不重新采集，只把 VIS 当前 buffer 导出来（换窗口/换通道时很有用）。"""
    out = args.out or os.path.join(os.getcwd(), "kingst_cap.csv")
    do_export(v, out, channels=args.channels, time_span=args.time_span, kvdat=not args.no_kvdat)
    print(f"已导出 {out}（{os.path.getsize(out)} B）")
    return 0


# ======================================================================
#  6. 命令行
# ======================================================================
def add_common(p):
    p.add_argument("--ch-clk", type=int, default=0)
    p.add_argument("--ch-dio", type=int, default=1)
    p.add_argument("--gap", type=float, default=2e-6, help="事务/突发间隔阈值（秒），默认 2us")


def cmd_spi(init, tracks, a) -> int:
    """按 CS 窗口解 SPI / QSPI（单线按字节、四线按 nibble），并标注 QSPI 命令帧的地址形状。

    为什么单独写：SPI/QSPI 屏（AXS15352 / ST77916）的线上协议是"CS 窗口 = 一条事务"，
    窗口内先是 opcode + 24 bit 地址（QSPI 命令帧），再是 1 线参数或 4 线像素。
    Socket API 挂不了解析器，所以这里自己解 —— 重点是把 **AD[23:0] 里命令字落在哪个字节** 标出来：
    ST77916 手册 §8.8.5.1 要求 `00 XX 00`（中间字节），写成 `XX 00 00` 或 `00 00 XX` 都要能一眼看见。
    """
    cs_ch, clk_ch = a.cs, a.clk
    d_chs = [a.d0] + [c for c in (a.d1, a.d2, a.d3) if c is not None]
    edge_want = getattr(a, "edge", "auto")
    if edge_want == "rising":
        sample_edge = 1
    elif edge_want == "falling":
        sample_edge = 0
    else:
        sample_edge = None                        # auto：下面按"哪一沿解出来更像整字节"选

    chans = set([cs_ch, clk_ch] + d_chs)
    events = []
    for ch in chans:
        for (t, lv) in tracks.get(ch, []):
            events.append((t, ch, lv))
    events.sort(key=lambda e: e[0])
    if not events:
        print("CSV 里这几个通道都没有跳变 —— 通道号对不上？（--cs/--clk/--d0…）")
        print("提示：先用 `list` 或 `stats` 看每个通道的跳变数。")
        return 1

    t0 = events[0][0]
    windows = []
    cur = None
    for (t, ch, lv) in events:
        if ch != cs_ch:
            continue
        if lv == 0 and cur is None:
            cur = {"t0": t, "samples": []}
        elif lv == 1 and cur is not None:
            cur["t1"] = t
            windows.append(cur)
            cur = None
    if cur is not None:                              # 末尾还没抬 CS：也算一个窗口
        cur["t1"] = events[-1][0]
        windows.append(cur)

    quad_any = False
    for w in windows:
        # **逐窗口**判四线：只有当 D1-D3 在这个 CS 窗口里有跳变，才按 nibble 解（否则单线字节）
        w["quad"] = any(w["t0"] <= t <= w["t1"] for ch in d_chs[1:] for (t, _lv) in tracks.get(ch, []))
        quad_any = quad_any or w["quad"]

    def collect(edge):
        for w in windows:
            w.setdefault("byedge", {})[edge] = [
                (t, [level_at(tracks.get(ch, []), t, init.get(ch, 0)) for ch in d_chs])
                for (t, ch, lv) in events
                if ch == clk_ch and w["t0"] < t < w["t1"] and lv == edge
            ]

    def score(edge):
        """哪一沿更像"真事务"：① 位宽是 8 的倍数的窗口比例；② **首字节稳定性** ——
        真实命令帧的首字节是固定 opcode（QSPI 的 02h），错半拍时首字节五花八门。
        只看 ① 分不出来（两沿都可能是 40 bit 整字节），必须靠 ②。"""
        firsts, good, tot = {}, 0, 0
        for w in windows:
            smp = w.get("byedge", {}).get(edge) or []
            if not smp:
                continue
            tot += 1
            if len(smp) % 8:
                continue
            good += 1
            bits = [b[0] for (_t, b) in smp]
            first = int("".join(str(x) for x in bits[:8]), 2)
            firsts[first] = firsts.get(first, 0) + 1
        if not tot:
            return 0.0, 0, 0
        stable = max(firsts.values()) / tot if firsts else 0.0
        return 0.5 * (good / tot) + 0.5 * stable, good, tot

    if sample_edge is None:
        collect(1); collect(0)
        s_up, s_dn = score(1), score(0)
        sample_edge = 1 if s_up[0] >= s_dn[0] else 0
        if abs(s_up[0] - s_dn[0]) > 0.1:
            print(f"⚠️ 两沿差别明显（打分 上升 {s_up[0]:.2f} vs 下降 {s_dn[0]:.2f}；"
                  f"整字节窗口 上升 {s_up[1]}/{s_up[2]} · 下降 {s_dn[1]}/{s_dn[2]}）"
                  f"→ 按**{'上升' if sample_edge else '下降'}沿**解。"
                  f"若与预期不符，多半是 LA 的 CLK/D0 **通道间延时**（半周期量级）—— "
                  f"换 `--edge rising|falling`，或把两根杜邦线等长/换个地")
    else:
        collect(sample_edge)

    for w in windows:
        w["samples"] = w.get("byedge", {}).get(sample_edge) or []

    print(f"CS 窗口 {len(windows)} 个 · 通道 CS=CH{cs_ch} CLK=CH{clk_ch} D0..=CH{','.join(str(c) for c in d_chs)}"
          f" · 取样沿={'上升' if sample_edge else '下降'}"
          f" · 其中四线窗口 {sum(1 for w in windows if w['quad'])} 个（D1-D3 有跳变）")
    shown = 0
    for i, w in enumerate(windows):
        if shown >= a.max:
            print(f"… 还有 {len(windows) - i} 个窗口没打印（--max 调大）")
            break
        smp = w["samples"]
        if not smp:
            print(f"CS#{i:<4} +{(w['t0']-t0)*1e3:9.4f} ms  （窗口里没有时钟沿：{(w['t1']-w['t0'])*1e6:.1f} µs）")
            shown += 1
            continue
        quad = w["quad"]
        if quad:
            nib = [(b[0] | (b[1] << 1) | (b[2] << 2) | (b[3] << 3)) for (_t, b) in smp]
            body = " ".join(f"{n:x}" for n in nib)
            note = f"四线 nibble ×{len(nib)}"
        else:
            bits = [b[0] for (_t, b) in smp]
            by = [int("".join(str(x) for x in bits[k:k + 8]), 2) for k in range(0, len(bits) - len(bits) % 8, 8)]
            body = " ".join(f"{v:02x}" for v in by)
            note = f"单线 {len(by)} B（{len(bits)} bit）"
            if len(bits) % 8:
                note += f" · 末尾 {len(bits) % 8} bit 不成字节"
            # QSPI 命令帧的形状判定：opcode + 24 bit 地址
            if len(by) >= 4:
                ad = (by[1] << 16) | (by[2] << 8) | by[3]
                if by[1] == 0 and by[3] == 0 and by[2] != 0:
                    note += f" · opcode=0x{by[0]:02x} AD=0x{ad:06x} → 命令 0x{by[2]:02x} ✓（00 XX 00）"
                elif by[2] == 0 and by[3] == 0 and by[1] != 0:
                    note += (f" · ⚠️ opcode=0x{by[0]:02x} AD=0x{ad:06x} → 命令字在**最高**字节"
                             f"（手册要 00 XX 00，即 0x00{by[1]:02x}00）")
                elif by[1] == 0 and by[2] == 0 and by[3] != 0:
                    note += (f" · ⚠️ opcode=0x{by[0]:02x} AD=0x{ad:06x} → 命令字在**最低**字节"
                             f"（手册要 00 XX 00，即 0x00{by[3]:02x}00）")
                else:
                    note += f" · opcode=0x{by[0]:02x} AD=0x{ad:06x}"
        head = body if len(body) <= a.width else body[:a.width] + " …"
        print(f"CS#{i:<4} +{(w['t0']-t0)*1e3:9.4f} ms  {head}   [{note}]")
        if getattr(a, "bits", 0) and i < a.bits:
            if quad:
                bs = "".join(format(n, "x") for n in nib)
            else:
                bs = "".join(str(b[0]) for (_t, b) in smp)
            grp = " ".join(bs[k:k + 8] for k in range(0, len(bs), 8))
            print(f"          位: {grp}   （窗口 {(w['t1']-w['t0'])*1e6:.2f} µs，{len(smp)} 个时钟沿）")
        shown += 1
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="金沙滩逻辑分析仪：采集 + 分析 + SWD 解码（只用标准库）")
    sub = ap.add_subparsers(dest="action", required=True)

    sub.add_parser("info")
    sub.add_parser("stop")

    g = sub.add_parser('glitch-filter-info', help='读 KVDAT 采集快照或磁盘预设，非实时 GUI 查询')
    g.add_argument('file', nargs='?', default=VIS_CONFIG)
    g.add_argument('--rate', type=lambda s:int(float(s)), help='用于计算滤波宽度，单位 Hz')
    g = sub.add_parser('glitch-filter-preset', help='生成滤波预设；应用时必须先退出 KingstVIS')
    g.add_argument('--config', default=VIS_CONFIG)
    g.add_argument('--channels', type=int, nargs='+', required=True)
    g.add_argument('--samples', type=int, default=1)
    g.add_argument('--disable', action='store_true', help='关闭选定通道的滤波')
    g.add_argument('--reset-on-restart', action='store_true', help='选择下次启动清除滤波；默认保留')
    group = g.add_mutually_exclusive_group(required=True)
    group.add_argument('--out', help='生成独立副本，不改变正在运行的 VIS')
    group.add_argument('--apply', action='store_true', help='备份后更新配置，下次启动生效')

    c = sub.add_parser("capture")
    c.add_argument("--rate", type=lambda s: int(float(s)), default=100_000_000)
    c.add_argument("--depth", type=lambda s: int(float(s)), default=1_000_000)
    c.add_argument("--time", type=float, default=None, help="用采样时间代替深度")
    c.add_argument("--threshold", type=float, default=1.65)
    c.add_argument("--channels", type=int, nargs="*", default=None)
    c.add_argument("--trigger", default=None,
                   help='整串传入，如 --trigger "--reset --pos-edge 0"（含 -- 的参数必须整串给）')
    c.add_argument("--out", default=None)
    c.add_argument("--stats", action="store_true", help="采完顺带打通道统计")
    c.add_argument("--timeout", type=float, default=120.0, help="start 阻塞超时（秒）")
    c.add_argument("--time-span", type=float, nargs="+", default=None,
                   help="只导这段时间窗（秒；以触发点为 0，可只给起点）—— 导出量能小一个数量级")
    c.add_argument("--no-kvdat", action="store_true",
                   help="不存 .kvdat 原始档（默认存一份，方便在 GUI 里回看同一次采集）")
    c.add_argument("--simulate", action="store_true",
                   help="明确要模拟采集（start --simulate）；默认把模拟当异常")
    c.add_argument("--force", action="store_true", help="忽略采样率/设备检查的告警继续跑")

    sub.add_parser("analyzers", help="列出 GUI 里已挂的协议解析器（只读 vis.config）")

    d = sub.add_parser("decoded", help="导出 VIS 内置协议解析器的解码结果")
    d.add_argument("--out", default=None)
    d.add_argument("--analyzer", type=int, default=None, help="解析器序号（从 0 开始）")
    d.add_argument("--dll", default=None, help="按 dll 名挑：SWD / QSPI / SPI / I2C …")
    d.add_argument("--all", action="store_true", help="把已挂的解析器全部导出")
    d.add_argument("--max", type=int, default=20, help="打印前 N 帧（默认 20）")
    d.add_argument("--grep", default="", help="只打印含该关键字的帧")

    e = sub.add_parser("export", help="不重新采集，只把 VIS 当前 buffer 导出来")
    e.add_argument("--out", default=None)
    e.add_argument("--channels", type=int, nargs="*", default=None)
    e.add_argument("--time-span", type=float, nargs="+", default=None)
    e.add_argument("--no-kvdat", action="store_true")

    for name in ("stats", "freq", "burst", "detail", "decode", "list"):
        p = sub.add_parser(name)
        p.add_argument("csv")
        add_common(p)
        if name == "decode":
            p.add_argument("--max", type=int, default=40)
        if name == "list":
            p.add_argument("--max", type=int, default=200)

    s = sub.add_parser("spi", help="按 CS 窗口解 SPI/QSPI（单线字节 / 四线 nibble），标注 QSPI 地址形状")
    s.add_argument("csv")
    s.add_argument("--cs", type=int, default=0, help="CS 通道（默认 0）")
    s.add_argument("--clk", type=int, default=1, help="SCK 通道（默认 1）")
    s.add_argument("--d0", type=int, default=2, help="数据线 0（默认 2；单线时就是 MOSI）")
    s.add_argument("--d1", type=int, default=3)
    s.add_argument("--d2", type=int, default=4)
    s.add_argument("--d3", type=int, default=5)
    s.add_argument("--edge", default="auto", choices=["auto", "rising", "falling"], help="按哪个时钟沿取样。auto（默认）= 两沿都解一遍，挑更像整字节的那个 —— LA 的 CLK/D0 通道间常有半周期延时，这时该用 falling")
    s.add_argument("--max", type=int, default=60, help="最多打印多少个 CS 窗口")
    s.add_argument("--width", type=int, default=160, help="每个窗口最多打印多少字符的 hex")

    s.add_argument("--bits", type=int, default=0, help="顺带打印前 N 个窗口的原始采样位")

    

    args = ap.parse_args()

    if args.action == 'glitch-filter-info':
        print(json.dumps(read_glitch_settings(args.file, args.rate), ensure_ascii=False, indent=2));return 0
    if args.action == 'glitch-filter-preset':
        return cmd_glitch_preset(args)

    # ---- 不需要 VIS 的（只读 vis.config）----
    if args.action == "analyzers":
        return cmd_analyzers()

    # ---- 需要连 VIS 的 ----
    if args.action in ("info", "stop", "capture", "decoded", "export"):
        v = Vis()
        try:
            if args.action == "info":
                for cmd in ("get-supported-sample-rate", "get-sample-rate", "get-actual-sample-depth",
                            "get-actual-sample-time", "get-last-error"):
                    print(f"{cmd:28} -> {v.cmd(cmd)}")
                return 0
            if args.action == "stop":
                # 🚨 上一次"武装了但没触发"的采集会一直占着硬件 → 之后 set-sample-rate 全部 NAK
                #    （报 "sampling in progress, cannot execute the command"）。先停掉。
                try:
                    print("stop ->", v.cmd("stop", timeout=5))
                except Exception as e:                      # noqa: BLE001
                    print("stop 未确认:", e)
                return 0

            if args.action == "decoded":
                return cmd_decoded(v, args)
            if args.action == "export":
                return cmd_export(v, args)

            # ---------------- capture ----------------
            # ① 设备在不在 / 采样率合不合法（get-supported-sample-rate 只读、最便宜）
            try:
                sup = [int(x) for x in v.cmd("get-supported-sample-rate").split()]
            except Exception as e:                      # noqa: BLE001
                sup = []
                print(f"⚠️ 读不到设备支持的采样率（{e}）—— 设备可能没连上")
            if sup:
                print("设备支持的采样率: " + " ".join(str(x) for x in sup))
                if args.rate not in sup and not args.force:
                    raise SystemExit(
                        f"🚨 请求的采样率 {args.rate} 不在设备支持列表里 —— 直接退，"
                        f"免得 VIS 只回一句没头没脑的 NAK（要硬试加 --force）")
            elif not args.force:
                raise SystemExit("🚨 拿不到设备支持的采样率列表（设备没连上？）—— 要硬试加 --force")

            err0 = _safe_last_error(v)
            print(f"设置采样率 {args.rate/1e6:g} MHz ... ", end="")
            v.cmd(f"set-sample-rate {args.rate}")
            print("OK")
            if args.time is not None:
                v.cmd(f"set-sample-time {args.time}")
                print(f"采样时间 {args.time} s")
            else:
                v.cmd(f"set-sample-depth {args.depth}")
                print(f"采样深度 {args.depth}")
            v.cmd(f"set-threshold-voltage {args.threshold}")
            if args.trigger:
                v.cmd("set-trigger " + args.trigger)
                print("触发: " + args.trigger)
            else:
                v.cmd("set-trigger --reset")

            out = args.out or os.path.join(os.getcwd(), "kingst_cap.csv")
            start_cmd = "start --simulate" if args.simulate else "start"
            print(f"开始采集（{start_cmd}，阻塞到采完）...")
            t0 = time.time()
            v.cmd(start_cmd, timeout=args.timeout)
            print(f"采集完成，用时 {time.time()-t0:.2f} s")
            depth = v.cmd("get-actual-sample-depth")
            span = v.cmd("get-actual-sample-time")
            print(f"实际深度 {depth}，时间窗 {span}")

            # ② 真数据防护：官方文档明说"设备掉线后 VIS 会进模拟状态"，
            #    不加区分就会把**模拟出来的假数据**当真 —— 这正是 start --simulate 存在的理由。
            if not args.simulate:
                nums = [float(x) for x in re.findall(r"-?\d+(?:\.\d+)?", span)]
                if depth.strip() in ("", "0") or not nums or max(abs(x) for x in nums) == 0.0:
                    print("🚨 实际深度/时间为 0 —— 这次很可能是模拟数据或压根没采到，别当真")
                err1 = _safe_last_error(v)
                if err1 != err0:
                    print(f"⚠️ 采集期间 VIS 报了错（可能掉线转模拟）：{err1}")

            # ③ 导出（--time-span 只导兴趣窗口；默认顺带存 .kvdat 备回看）
            do_export(v, out, channels=args.channels, time_span=args.time_span,
                      kvdat=not args.no_kvdat)
            print(f"已导出 {out}（{os.path.getsize(out)} B）")
            init, tracks, chans = parse_csv(out)
            if not any(tracks.values()):
                print("🚨 导出的 CSV 里一条跳变都没有 —— 采样没采到东西（先 stop 再重来）")
            if args.stats:
                print(f"\n== 通道统计（{len(chans)} 通道：{chans}）==")
                for ch in chans:
                    stats(tracks.get(ch, []), ch)
            return 0
        finally:
            v.close()

    # ---- 纯离线分析 ----
    init, tracks, _chans = parse_csv(args.csv)
    if args.action == "stats":
        for ch in sorted(tracks):
            stats(tracks[ch], ch)
        return 0
    if args.action == "spi":
        return cmd_spi(init, tracks, args)
    return {"freq": cmd_freq, "burst": cmd_burst, "detail": cmd_detail,
            "decode": cmd_decode, "list": cmd_list}[args.action](init, tracks, args)


if __name__ == "__main__":
    sys.exit(main())

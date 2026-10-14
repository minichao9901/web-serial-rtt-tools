#!/usr/bin/env python3
"""Kingst 跳变 CSV → 4 位 DDR trace 字节流候选；尚不解码 ETM 指令。"""
import argparse
import bisect
import csv
import hashlib
import json
import re
import statistics
from pathlib import Path


def read_tracks(path):
    initial, tracks = {}, {}
    start = end = None
    with path.open('rb') as stream:
        header_bytes = stream.readline()
    try:
        if header_bytes.startswith((b'\xff\xfe',b'\xfe\xff')):encoding='utf-16'
        else:
            header_bytes.decode('utf-8-sig')
            encoding = 'utf-8-sig'
    except UnicodeDecodeError:
        # 中文 KingstVIS 使用 Windows 本地编码导出“通道 N”表头。
        header_bytes.decode('gb18030')
        encoding = 'gb18030'
    with path.open(newline='', encoding=encoding) as stream:
        reader = csv.reader(stream)
        header = next((r for r in reader if r), None)
        if not header:
            raise ValueError('CSV 为空。')
        channels = []
        for name in header[1:]:
            match = re.search(r'\d+', name)
            if not match:
                raise ValueError(f'不能识别通道表头：{name!r}')
            channels.append(int(match.group()))
        if len(set(channels)) != len(channels):
            raise ValueError('CSV 通道号重复。')
        levels = {}
        for row in reader:
            if not row or not row[0].strip():
                continue
            try:
                timestamp = float(row[0])
            except ValueError:
                raise ValueError(f'不是 Kingst 秒数时间列：{row[0]!r}') from None
            if end is not None and timestamp < end:
                raise ValueError('CSV 时间倒序。')
            if len(row) != len(header):
                raise ValueError('CSV 行的通道数与表头不一致。')
            if start is None:
                start = timestamp
            end = timestamp
            for channel, value in zip(channels, row[1:]):
                value = value.strip()
                if value not in ('0', '1'):
                    raise ValueError(f'CH{channel} 电平不是 0/1：{value!r}')
                level = int(value)
                if channel not in initial:
                    initial[channel] = level
                    tracks[channel] = []
                elif levels[channel] != level:
                    tracks[channel].append((timestamp, level))
                levels[channel] = level
    if start is None:
        raise ValueError('CSV 没有数据行。')
    return initial, tracks, start, end


def pack_nibbles(nibbles, phase):
    return bytes(nibbles[i] | (nibbles[i + 1] << 4)
                 for i in range(phase, len(nibbles) - 1, 2))


def extract(path, clock, data, fraction=0.25):
    if not 0 < fraction < 1:
        raise ValueError('取样位置必须介于 0 和 1。')
    initial, tracks, start, end = read_tracks(path)
    needed = [clock] + data
    if len(set(needed)) != 5 or len(data) != 4:
        raise ValueError('需要五个不同通道：时钟 + D0/D1/D2/D3。')
    missing = set(needed) - set(initial)
    if missing:
        raise ValueError(f'CSV 缺少通道：{sorted(missing)}')
    edges = tracks[clock]
    if len(edges) < 4:
        raise ValueError('TRACECLK 没有足够跳变。')
    intervals = [b[0] - a[0] for a, b in zip(edges, edges[1:])]
    if any(dt <= 0 for dt in intervals):
        raise ValueError('同一时刻存在多个时钟跳变。')
    half_period = statistics.median(intervals)
    periods = [edges[i + 2][0] - edges[i][0] for i in range(len(edges) - 2)]
    # Windowed full-cycle estimates tolerate 2 ns quantization. Keep changes
    # and clock gaps visible rather than treating a reset-to-PLL capture as one clock.
    clock_runs = []
    for offset in range(0, len(edges)-2, 256):
        chunk=edges[offset:min(offset+257,len(edges))]
        if len(chunk)<3:continue
        duration=chunk[-1][0]-chunk[0][0]
        frequency=(len(chunk)-1)/duration/2
        if clock_runs and abs(frequency/clock_runs[-1]['clock_hz_average']-1)<.05:
            run=clock_runs[-1];run['end_seconds']=chunk[-1][0];run['half_cycles']+=len(chunk)-1
            run['clock_hz_average']=run['half_cycles']/(run['end_seconds']-run['start_seconds'])/2
        else:clock_runs.append(dict(start_seconds=chunk[0][0],end_seconds=chunk[-1][0],
                                  half_cycles=len(chunk)-1,clock_hz_average=frequency))
    gaps=[dict(edge=i,time_seconds=edges[i][0],duration_ns=dt*1e9)
          for i,dt in enumerate(intervals) if dt>max(half_period*8,1e-6)]
    nibbles = []
    prepared = [(ch, [t for t, _ in tracks[ch]], [lv for _, lv in tracks[ch]])
                for ch in data]
    min_margin = float('inf')
    for a, b in zip(edges, edges[1:]):
        sample = a[0] + (b[0] - a[0]) * fraction
        value = 0
        for bit, (ch, times, levels) in enumerate(prepared):
            index = bisect.bisect_right(times, sample)
            level = initial[ch] if index == 0 else levels[index - 1]
            value |= level << bit
            if index:
                min_margin = min(min_margin, sample - times[index - 1])
            if index < len(times):
                min_margin = min(min_margin, times[index] - sample)
        nibbles.append(value)
    streams = [pack_nibbles(nibbles, phase) for phase in (0, 1)]
    sync = b'\xff\xff\xff\x7f'
    report = {
        'input': str(path.resolve()),
        'input_sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
        'stage': 'physical DDR extraction only; no TPIU demux or ETM instruction decode',
        'clock_channel': clock, 'data_channels_D0_to_D3': data,
        'window_seconds': [start, end], 'clock_edges': len(edges),
        'clock_hz_median': 1.0 / statistics.median(periods),
        'clock_hz_average': (len(edges) - 1) / (edges[-1][0] - edges[0][0]) / 2,
        'half_period_ns': half_period * 1e9,
        'irregular_half_periods': sum(abs(dt / half_period - 1) > 0.25 for dt in intervals),
        'clock_runs':clock_runs,'clock_gaps':gaps,
        'data_transitions': {f'CH{ch}': len(tracks[ch]) for ch in data},
        'sample_fraction_after_each_edge': fraction,
        'min_data_transition_distance_ns': None if min_margin == float('inf') else min_margin * 1e9,
        'nibbles': len(nibbles),
        'candidates': [{'phase': i, 'bytes': len(buf), 'frame_sync_matches': buf.count(sync),
                        'first_32_bytes_hex': buf[:32].hex(' ')} for i, buf in enumerate(streams)],
        'note': 'Byte phase must be confirmed by TPIU framing and ETM decode; sync matches alone do not prove valid capture.',
    }
    return report, streams


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('csv', type=Path)
    parser.add_argument('--clock', type=int, default=0)
    parser.add_argument('--data', nargs=4, type=int, default=[1, 2, 3, 4], metavar='CH')
    parser.add_argument('--sample-fraction', type=float, default=0.25,
                        help='每个半周期内的取样位置，默认 0.25；实测 H7B0 中点为数据跳变区')
    parser.add_argument('--out', type=Path, help='输出路径前缀，默认 CSV 同名')
    args = parser.parse_args()
    if not 0 < args.sample_fraction < 1:
        parser.error('--sample-fraction 必须介于 0 和 1 之间。')
    try:
        report, streams = extract(args.csv, args.clock, args.data, args.sample_fraction)
    except (ValueError, OSError) as error:
        parser.exit(1, f'分析失败：{error}\n')
    prefix = args.out or args.csv.with_suffix('')
    prefix.parent.mkdir(parents=True, exist_ok=True)
    for i, stream in enumerate(streams):
        out = Path(str(prefix) + f'.phase{i}.bin')
        out.write_bytes(stream)
        report['candidates'][i]['file'] = str(out.resolve())
    out = Path(str(prefix) + '.trace.json')
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f"TRACECLK 均值 = {report['clock_hz_average'] / 1e6:.6f} MHz，中位 = {report['clock_hz_median'] / 1e6:.4f} MHz；半周期 = {report['half_period_ns']:.1f} ns")
    print(f"时钟跳变 {report['clock_edges']}，异常半周期 {report['irregular_half_periods']}")
    print(f"数据跳变：{report['data_transitions']}")
    print(f"取样点至最近数据跳变的最小距离：{report['min_data_transition_distance_ns']} ns")
    margin = report['min_data_transition_distance_ns']
    if margin is not None and margin < 5:
        print('注意：取样点接近数据跳变，请调整 --sample-fraction 后重新核对。')
    for candidate in report['candidates']:
        print(f"phase{candidate['phase']}: {candidate['bytes']} bytes，FSYNC 候选 {candidate['frame_sync_matches']}")
    print(f'报告：{out}')
    print('当前只恢复物理字节流；实际执行流需要后续 TPIU + ETM 解码。')


if __name__ == '__main__':
    main()

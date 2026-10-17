#!/usr/bin/env python3
"""解复用带 FSYNC/HSYNC 的四位并行 TPIU 字节流；不解码 ETM 指令。"""
import argparse
import json
from pathlib import Path

FSYNC = bytes.fromhex('ff ff ff 7f')
HSYNC = bytes.fromhex('ff 7f')


def demux(raw):
    position = raw.find(FSYNC)
    if position < 0:
        raise ValueError('没有 FSYNC，无法确认 TPIU 帧起点。')
    skipped = position
    frame = bytearray()
    current = None
    streams = {}
    stats = dict(frames=0, fsyncs=0, hsyncs=0, errors=0, unknown_bytes=0,
                 initial_skipped_bytes=skipped, id_changes=[], trailing_sync_bytes=0,
                 idle_resyncs=0, dropped_partial_frame_bytes=0, mid_frame_fsyncs=0)

    def emit(source, value):
        if source is None:
            stats['unknown_bytes'] += 1
        else:
            streams.setdefault(source, bytearray()).append(value)

    while position < len(raw):
        # A capture may end 1..3 bytes into FSYNC at a frame boundary.
        # Keep that fragment as an explicit boundary; never treat it as an ID
        # or ignore a full/partial sync in the middle of a frame.
        remaining = len(raw) - position
        if not frame and remaining < len(FSYNC) and raw[position:] == FSYNC[:remaining]:
            stats['trailing_sync_bytes'] = remaining
            break
        if position + 2 > len(raw):
            break
        if not frame and raw[position:position + 4] == FSYNC:
            stats['fsyncs'] += 1
            position += 4
            continue
        pair = raw[position:position + 2]
        if pair == HSYNC:
            stats['hsyncs'] += 1
            position += 2
            continue
        if pair == b'\xff\xff':
            # Arm IHI0029D D4.2.2: full sync occurs BETWEEN frames.
            # Only halfword sync may interrupt a frame (D4.2.3).
            # Joining a partial frame across FSYNC can fabricate trace bytes.
            raise ValueError(f'TPIU 帧内完整同步或非法源 ID 0x7f（物理偏移 {position}，帧内 {len(frame)} 字节）；拒绝拼接损坏帧')
        frame.extend(pair)
        position += 2
        if len(frame) != 16:
            continue
        flags = frame[15]
        for i in range(0, 15, 2):
            flag = (flags >> (i // 2)) & 1
            value = frame[i]
            if value & 1:
                new = value >> 1
                previous = current
                if new != current:
                    stats['id_changes'].append(new)
                current = new
                if i < 14:
                    emit(previous if flag and new != previous else current, frame[i + 1])
            else:
                emit(current, value | flag)
                if i < 14:
                    emit(current, frame[i + 1])
        frame.clear()
        stats['frames'] += 1
    stats['trailing_frame_bytes'] = len(frame)
    stats['trailing_raw_bytes'] = len(raw) - position
    stats['stream_bytes'] = {str(source): len(buf) for source, buf in streams.items()}
    return stats, {source: bytes(buf) for source, buf in streams.items()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path)
    parser.add_argument('--out', type=Path)
    args = parser.parse_args()
    try:
        report, streams = demux(args.input.read_bytes())
    except (OSError, ValueError) as error:
        parser.exit(1, f'TPIU 分析失败：{error}\n')
    prefix = args.out or args.input.with_suffix('')
    report['input'] = str(args.input.resolve())
    report['stage'] = 'TPIU frame demultiplex only; ETM instruction decode not performed'
    report['streams'] = {}
    for source, buf in streams.items():
        out = Path(str(prefix) + f'.id{source}.bin')
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(buf)
        report['streams'][str(source)] = {
            'file': str(out.resolve()), 'bytes': len(buf),
            'first_64_bytes_hex': buf[:64].hex(' '),
            'etmv4_async_candidates': buf.count(bytes(11) + b'\x80'),
            'etmv3_async_candidates': buf.count(bytes(5) + b'\x80'),
        }
    out = Path(str(prefix) + '.tpiu.json')
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding='utf-8')
    print(f"TPIU: {report['frames']} 帧，FSYNC {report['fsyncs']}，HSYNC {report['hsyncs']}，结构错误 {report['errors']}")
    print(f"数据源字节数：{report['stream_bytes']}")
    print(f'报告：{out}')


if __name__ == '__main__':
    main()

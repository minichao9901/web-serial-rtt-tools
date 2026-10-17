"""流式展开与派生分析；事件保存在 JSONL，内存不随展开指令数线性增长。

与常规解码一致地保留条件执行未知、调用栈及真实包字节核算。
events/packets/elements 只存 JSONL；decoded.json 是小型元数据与分析摘要。
注意：CSV 取样仍加载跳变轨迹，ETM 输入、ELF 和派生调用树也占内存；
本模块不声称整个采集链路 O(1) 或支持无限长度。
"""
import collections
import hashlib
import json
import subprocess
from pathlib import Path

from capstone import Cs, CS_ARCH_ARM, CS_MODE_THUMB, CS_MODE_MCLASS

import decode_trace as decoder_runtime
from decode_trace import DEFAULT_CONFIG, REG_ORDER, V3_REG_ORDER, Image, decoder_config

from flow_analysis import possible_predicates, mark_execution, analyze_calls, byte_accounting
from stream_store import JsonLines

FAULT_TERMS = ('OVERFLOW', 'BAD_SEQUENCE', 'BAD_TRACEMODE', 'RESERVED')
CACHE_MAX = 8192


def _native():
    # The portable launcher selects the bundled snapshot AFTER module imports.
    # Do not capture a stale copy of decode_trace.ROOT at import time.
    native = decoder_runtime.ROOT / 'build-native/etm_decode.exe'
    if not native.exists():
        raise ValueError('缺少 OpenCSD 解码器，请先运行 build-decoder.ps1。')
    return native


def _write_array(handle, source, key):
    """把 JSONL 文件拼成一个 JSON 数组。"""
    handle.write(json.dumps(key) + ':[')
    first = True
    with source.open(encoding='utf-8') as lines:
        for line in lines:
            line = line.strip()
            if not line:
                continue
            handle.write(('' if first else ',') + line)
            first = False
    handle.write(']')


def decode_stream(id_stream, elf, workdir, config=None, sources=None, max_events=None,
                  progress_every=500000):
    """流式解码；返回精简结果（不含 events/packets/elements 本体）。"""
    workdir = Path(workdir).resolve()
    workdir.mkdir(parents=True, exist_ok=True)
    config = decoder_config(config)
    protocol = 'ETMv3' if str(config.get('protocol', 'ETMv4')) == 'ETMv3' else 'ETMv4'
    image = Image(elf, sources)

    (workdir / 'etm.bin').write_bytes(id_stream)
    order = V3_REG_ORDER if protocol == 'ETMv3' else REG_ORDER
    manifest = ('ETMv3\n' if protocol == 'ETMv3' else '')
    manifest += '\n'.join(hex(int(config[k])) for k in order) + '\n'
    for index, (base, data) in enumerate(image.segments):
        f = workdir / f'image-{index}.bin'
        f.write_bytes(data)
        manifest += f'{hex(base)} {f.resolve()}\n'
    manifest_file = workdir / 'native-config.txt'
    manifest_file.write_text(manifest, encoding='utf-8')

    native_jsonl = workdir / 'native.jsonl'
    with native_jsonl.open('wb') as out:
        process = subprocess.run([str(_native()), str(workdir / 'etm.bin'), str(manifest_file)],
                                 stdout=out, stderr=subprocess.PIPE, timeout=900)
    (workdir / 'native.log').write_bytes(process.stderr or b'')
    if process.returncode:
        raise ValueError('OpenCSD 解码失败：' + (process.stderr or b'').decode('utf-8', 'replace')[-3000:])

    disassembler = Cs(CS_ARCH_ARM, CS_MODE_THUMB | CS_MODE_MCLASS)
    cache = {}
    counts = collections.Counter()
    source_files = set()
    seq = 0
    instruction_count = executed = mapped = 0
    ranges = exceptions = gaps = faults = 0
    packets_n = elements_n = 0
    status = {}

    events_jsonl = workdir / 'events.jsonl'
    packets_jsonl = workdir / 'packets.jsonl'
    elements_jsonl = workdir / 'elements.jsonl'

    def emit(handle, obj):
        # 一行一个 JSON 对象（真正的 JSONL）：便于流式再读（导出简化 C、统计），
        # 拼 decoded.json 时由 _write_array() 负责补逗号。
        handle.write(json.dumps(obj, ensure_ascii=False) + '\n')

    with events_jsonl.open('w', encoding='utf-8') as ev_out, \
            packets_jsonl.open('w', encoding='utf-8') as pk_out, \
            elements_jsonl.open('w', encoding='utf-8') as el_out, \
            native_jsonl.open(encoding='utf-8', errors='replace') as src:

        for line in src:
            if not line.startswith('{'):
                continue
            record = json.loads(line)
            kind = record.get('kind')
            if kind == 'packet':
                emit(pk_out, record)
                packets_n += 1
                text = str(record.get('text', '')).upper()
                if any(term in text for term in FAULT_TERMS):
                    faults += 1
                continue
            if kind == 'status':
                status = record
                continue
            if kind != 'element':
                continue
            emit(el_out, record)
            elements_n += 1
            etype = record['type']
            if etype == 5:
                ranges += 1
                start, end = record['start'], record['end']
                key = (start, end)
                ins_list = cache.get(key)
                if ins_list is None:
                    if len(cache) > CACHE_MAX:
                        cache.clear()
                    ins_list = list(disassembler.disasm(image.read(start, end - start), start))
                    cache[key] = ins_list
                if (len(ins_list) != record['payload'] or not ins_list
                        or ins_list[-1].address + ins_list[-1].size != end):
                    raise ValueError(
                        f'机器码范围核对失败：0x{start:08x}..0x{end:08x}；'
                        f'OpenCSD={record["payload"]}，反汇编={len(ins_list)}。')
                last = len(ins_list) - 1
                for index, ins in enumerate(ins_list):
                    function, file, line_no = image.location(ins.address)
                    executed_here = bool(record['lastExecuted']) if index == last else True
                    event = dict(kind='instruction', seq=seq, offset=record['offset'],
                                 pc=ins.address, size=ins.size, bytes=ins.bytes.hex(),
                                 mnemonic=ins.mnemonic, operands=ins.op_str,
                                 executed=executed_here, function=function, file=file,
                                 line=line_no)
                    emit(ev_out, event)
                    seq += 1
                    instruction_count += 1
                    if executed_here:
                        executed += 1
                        counts[function or '(未知函数)'] += 1
                    if line_no:
                        mapped += 1
                    if file:
                        source_files.add(file)
                    if max_events and instruction_count > max_events:
                        raise ValueError(f'已超过 --max-events={max_events}；流式解码本身没有上限。')
                    if progress_every and instruction_count % progress_every == 0:
                        print(f'  流式解码：已展开 {instruction_count} 条指令（seq={seq}）', flush=True)
            elif etype in (1, 2, 3, 6, 7, 8, 9, 10):
                event = dict(kind='event', seq=seq, type=etype, offset=record['offset'],
                             text=record['text'], payload=record['payload'],
                             start=record['start'], end=record['end'], flags=record['flags'])
                emit(ev_out, event)
                seq += 1
                if etype == 9:
                    exceptions += 1
                if etype in (1, 6, 7, 8) or (etype == 2 and record['payload']):
                    gaps += 1

    if not instruction_count:
        raise ValueError('没有恢复到可信指令范围；原始采集和 native 包记录已保留。'
                         '请检查 CPU 是否继续、ETM 同步、Trace ID 与匹配 ELF。')

    sources_data = {f: image.source(f) for f in sorted(source_files)}
    (workdir / 'sources.json').write_text(json.dumps(sources_data, ensure_ascii=False),
                                          encoding='utf-8')
    processed = int(status.get('processed') or 0)
    result = dict(
        version=1, protocol=protocol, config=config, inputBytes=len(id_stream),
        elf=dict(name=Path(elf).name, sha256=hashlib.sha256(image.bytes).hexdigest()),
        summary=dict(packets=packets_n, ranges=ranges, instructions=instruction_count,
                     executed=executed, sourceMapped=mapped, exceptions=exceptions,
                     gaps=gaps, packetIssues=faults, functions=dict(counts)),
        status=status, timeBasis='execution order; no per-instruction timestamp',
        streamed=dict(eventsFile='events.jsonl', events=seq, elements=elements_n,
                      packets=packets_n, nativeJsonl='native.jsonl'),
        quality=dict(inputBytes=len(id_stream), processedBytes=processed,
                     unprocessedBytes=max(0, len(id_stream) - processed),
                     overlapBytes=0, unaccountedBytes=max(0, len(id_stream) - processed)))

    # Keep the same predicate/call-stack semantics as the ordinary web decoder.
    # Unique PCs are bounded by the executable image, not by loop iterations.
    unique = {}
    for event in JsonLines(events_jsonl, seq):
        if event['kind'] == 'instruction':
            unique.setdefault(event['pc'], event)
    predicates = possible_predicates(image, unique.values())
    del unique
    enriched = workdir / 'events.enriched.jsonl'
    with enriched.open('w', encoding='utf-8') as output:
        def events():
            block = []
            def drain():
                mark_execution(block, predicates)
                for event in block:
                    yield event  # analyze_calls adds callPath before iteration resumes
                    output.write(json.dumps(event, ensure_ascii=False) + '\n')
            for event in JsonLines(events_jsonl, seq):
                block.append(event)
                if len(block) >= 4096:
                    yield from drain()
                    block.clear()
            yield from drain()
        result['analysis'] = analyze_calls(events())
    enriched.replace(events_jsonl)
    result['events'] = JsonLines(events_jsonl, seq)
    result['packets'] = JsonLines(packets_jsonl, packets_n)
    result['elements'] = JsonLines(elements_jsonl, elements_n)
    result['quality'] = byte_accounting(result)
    result['summary']['executed'] = sum(e['kind'] == 'instruction' and e.get('executed') is True for e in result['events'])
    result['summary']['unknownExecution'] = result['quality']['unknownExecution']
    result['summary']['packetIssues'] = result['quality']['packetIssues']
    result['summary']['functions'] = {r['function']: r['knownExecuted'] for r in result['analysis']['functions'] if r['knownExecuted']}
    result['version'] = 3
    result['streamed']['schema'] = 2
    for key in ('events', 'packets', 'elements'):
        result.pop(key)
    (workdir / 'decoded.json').write_text(json.dumps(result, ensure_ascii=False), encoding='utf-8')
    return result


def decode_capture_stream(csv_path, elf, workdir, config=None, sources=None, fraction=0.25,
                          clock=0, data=None, max_events=None, glitch_ns=0):
    """从 LA 的 CSV 开始走完整条流式链路（取样相位 + TPIU 解复用 + 解码）。"""
    from trace_port import extract
    from tpiu_demux import demux

    csv_path, workdir = Path(csv_path).resolve(), Path(workdir).resolve()
    config = decoder_config(config)
    physical, candidates = extract(csv_path, clock, data or [1, 2, 3, 4], fraction, glitch_ns)
    valid = []
    failures=[]
    workdir.mkdir(parents=True,exist_ok=True)
    (workdir/'physical.json').write_text(json.dumps(physical,ensure_ascii=False),encoding='utf8')
    for phase, raw in enumerate(candidates):
        try:
            frames, streams = demux(raw)
            if int(config['traceid']) in streams and frames['frames']:
                valid.append((phase, frames, streams))
        except ValueError as error:
            failures.append({'phase':phase,'error':str(error)})
            continue
    if len(valid) != 1:
        (workdir/'demux-errors.json').write_text(json.dumps(failures,ensure_ascii=False),encoding='utf8')
        raise ValueError(f'不能唯一确定 TPIU 字节相位：{len(valid)} 个候选；请检查通道和取样位置。'+ (' '+failures[-1]['error'] if failures else ''))
    phase, frames, streams = valid[0]
    workdir.mkdir(parents=True, exist_ok=True)
    (workdir / 'tpiu.bin').write_bytes(candidates[phase])
    framing = {**frames, 'phase': phase}
    (workdir / 'framing.json').write_text(json.dumps(framing, ensure_ascii=False), encoding='utf-8')
    (workdir / 'physical.json').write_text(json.dumps(physical, ensure_ascii=False), encoding='utf-8')
    result = decode_stream(streams[int(config['traceid'])], elf, workdir, config, sources,
                           max_events=max_events)
    result['physical'] = physical
    result['framing'] = framing
    with csv_path.open('rb') as stream:
        capture_hash = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1024*1024), b''):
            capture_hash.update(chunk)
    result['capture'] = {'name': csv_path.name, 'sha256': capture_hash.hexdigest()}
    # Recompute physical boundary fields after attaching framing. No large JSON reread.
    streams_result = {**result, 'events': JsonLines(workdir / 'events.jsonl', result['streamed']['events']),
                      'packets': JsonLines(workdir / 'packets.jsonl', result['streamed']['packets']),
                      'elements': JsonLines(workdir / 'elements.jsonl', result['streamed']['elements'])}
    result['quality'] = byte_accounting(streams_result)
    (workdir / 'decoded.json').write_text(json.dumps(result, ensure_ascii=False), encoding='utf-8')
    return result


def export_simplified_stream(workdir, out_path):
    """从 events.jsonl 流式生成「简化源码 .c」（与网页同一条行规则）。"""
    from source_export import base

    workdir, out_path = Path(workdir).resolve(), Path(out_path).resolve()
    sources = json.loads((workdir / 'sources.json').read_text(encoding='utf-8'))
    source_lines = {f: t.splitlines() for f, t in sources.items()}
    events = workdir / 'events.jsonl'
    clean = lambda text: str(text).replace('*/', '* /')          # noqa: E731

    files, seen = [], set()
    for event in JsonLines(events,None):
        f = event.get('file')
        if f and f not in seen:
            seen.add(f)
            files.append(f)

    rows = 0
    with out_path.open('w', encoding='utf-8') as out:
        out.write('/* ETMv4 简化源码执行流：按恢复顺序排列，不是可编译程序。 */\n')
        out.write(f'/* 流式导出：events.jsonl 共 {events.stat().st_size} 字节 */\n')
        for f in files:
            out.write('/* 配套文件：' + clean(base(f)) + ' = ' + clean(f) + ' */\n')
        last = None
        context = None
        for event in JsonLines(events,None):
            seq = event.get('seq', rows)
            if event.get('kind') != 'instruction':
                if event.get('type') in (1, 2, 3, 6, 7, 8, 9, 10):
                    out.write('/* #' + str(seq) + ' ' + clean(event.get('text', '')) + ' */\n')
                    rows += 1
                    last = None
                continue
            file, line_no = event.get('file', ''), event.get('line')
            function = event.get('function', '')
            if event.get('executionState') == 'unknown' or event.get('executed') is None:
                out.write('/* #' + str(seq) + ' 条件执行状态未知，不视为已证实执行 */\n')
                rows += 1
                last = context = None
                continue
            if not event.get('executed'):
                continue
            content = source_lines.get(file, [])
            if not line_no or not 0 < line_no <= len(content):
                out.write('/* #' + str(seq) + f' PC=0x{event["pc"]:08x} 无配套源码 */\n')
                rows += 1
                last = None
                continue
            key = (function, file, line_no)
            if key == last:
                continue
            if (function, file) != context:
                out.write('/* ' + clean(function) + ' · ' + clean(base(file)) + ' */\n')
                context = (function, file)
            out.write(content[line_no - 1] + '\n')
            rows += 1
            last = key
    return rows

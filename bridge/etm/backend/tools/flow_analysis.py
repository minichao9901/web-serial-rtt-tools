"""执行流派生分析：明确未知状态，不把函数切换当成调用或把计数当耗时。"""
from collections import Counter, defaultdict
from capstone import Cs, CS_ARCH_ARM, CS_MODE_THUMB, CS_MODE_MCLASS
from capstone.arm import ARM_INS_IT, ARM_INS_BL, ARM_INS_BLX, ARM_CC_AL, ARM_CC_INVALID


def predicate_addresses(image):
    """从完整函数的机器码找到 IT 保护的指令；不推测条件是否成立。"""
    decoder = Cs(CS_ARCH_ARM, CS_MODE_THUMB | CS_MODE_MCLASS)
    decoder.detail = True
    addresses = set()
    for address, size, _ in image.functions:
        remaining = 0
        for ins in decoder.disasm(image.read(address, size), address):
            if ins.id == ARM_INS_IT:
                remaining = len(ins.mnemonic) - 1
            elif remaining:
                addresses.add(ins.address)
                remaining -= 1
    return addresses


def possible_predicates(image, events):
    addresses = predicate_addresses(image)
    known = set()
    decoder = Cs(CS_ARCH_ARM, CS_MODE_THUMB | CS_MODE_MCLASS)
    decoder.detail = True
    for start, size, _ in image.functions:
        known.update(i.address for i in decoder.disasm(image.read(start,size),start))
    # A stripped image or undecodable function can begin a trace inside IT.
    # Mark plausible guarded slots unknown instead of assuming unconditional.
    for pc in {e['pc'] for e in events if e['kind']=='instruction'}-known:
        for start in range(max(0,pc-18),pc,2):
            decoded=list(decoder.disasm(image.read(start,pc-start+4),start))
            if decoded and decoded[0].id==ARM_INS_IT:
                count=len(decoded[0].mnemonic)-1
                if any(i.address==pc for i in decoded[1:count+1]):
                    addresses.add(pc)
                    break
    return addresses


def instruction_info(ins):
    mnemonic, operands = ins.mnemonic, ins.op_str
    if ins.id in (ARM_INS_BL, ARM_INS_BLX):
        flow = 'call'
    elif mnemonic.startswith('bx') or ((mnemonic.startswith('pop') or mnemonic.startswith('ldm')) and 'pc' in operands):
        flow = 'return' if 'lr' in operands or 'pc' in operands else 'branch'
    elif 1 in ins.groups or any(ins.reg_name(r)=='pc' for r in ins.regs_access()[1]):
        flow = 'branch'
    else:
        flow = 'linear'
    return dict(flow=flow, conditional=ins.cc not in (ARM_CC_AL, ARM_CC_INVALID))


def mark_execution(events, predicates=None):
    """给历史记录升级状态。None 表示当前 trace 没有证实谓词结果。"""
    predicates = predicates or set()
    decoder = Cs(CS_ARCH_ARM, CS_MODE_THUMB | CS_MODE_MCLASS)
    decoder.detail = True
    cache = {}
    for e in events:
        if e['kind'] != 'instruction':
            continue
        key = (e['pc'], e['bytes'])
        if key not in cache:
            ins = next(decoder.disasm(bytes.fromhex(e['bytes']), e['pc']), None)
            cache[key] = instruction_info(ins) if ins else dict(flow='unknown', conditional=True)
        e.update(cache[key])
        unknown = e.get('executed') is None or (e['pc'] in predicates and e['flow'] == 'linear')
        if unknown:
            e['executed'] = None
            e['executionState'] = 'unknown'
            e['executionReason'] = 'IT 非分支条件指令：当前 trace 未记录条件结果'
        else:
            e['executionState'] = 'executed' if e['executed'] else 'not-taken'
            e['executionReason'] = ''


def byte_accounting(result):
    size = result.get('status', {}).get('processed', 0)
    input_size=result.get('inputBytes',size)
    packets = result['packets']
    # Native packets are monotonic. Legacy in-memory records may be unordered.
    ordered = sorted(packets, key=lambda p: p['offset']) if isinstance(packets, list) else packets
    end = covered = overlap = unknown = unsync_records = invalid_count = overflow_count = packet_count = 0
    previous = -1
    for packet in ordered:
        start, stop = packet['offset'], packet['offset'] + packet['size']
        if start < previous:
            raise ValueError('包偏移倒序，拒绝伪造字节对账')
        previous = start
        if start < end:
            overlap += max(0, min(end, stop) - start)
        covered += max(0, stop - max(start, end))
        end = max(end, stop)
        text = packet.get('text', '')
        packet_count += 1
        if text.startswith(('I_NOT_SYNC', 'NOTSYNC')):
            unknown += packet['size']
            unsync_records += 1
        if any(t in text.upper() for t in ('BAD_', 'RESERVED', 'OVERFLOW', 'INCOMPLETE_EOT')):
            invalid_count += 1
            overflow_count += 'OVERFLOW' in text.upper()
    unknown_execution = sum(e.get('executionState') == 'unknown' for e in result['events'])
    framing = result.get('framing', {})
    return dict(inputBytes=input_size,unprocessedBytes=max(0,input_size-size),processedBytes=size, accountedBytes=covered, overlapBytes=overlap,
                unaccountedBytes=max(0, input_size-covered), unsynchronizedBytes=unknown,
                unsynchronizedRecords=unsync_records, validPackets=packet_count-unsync_records-invalid_count,
                packetIssues=invalid_count, overflowPackets=overflow_count,
                decoderLastError=result.get('status', {}).get('lastErrorCode', None),
                unknownExecution=unknown_execution, initialPhysicalBytes=framing.get('initial_skipped_bytes'),
                unknownSourceBytes=framing.get('unknown_bytes'), trailingFrameBytes=framing.get('trailing_frame_bytes'),
                trailingSyncBytes=framing.get('trailing_sync_bytes',0),
                firstPathOffset=next((e['offset'] for e in result['events'] if e['kind']=='instruction'), None),
                boundaryPresent=bool(unknown or framing.get('initial_skipped_bytes') or framing.get('trailing_frame_bytes') or framing.get('trailing_sync_bytes')),
                timing=dict(cycleElements=sum(e['type']==12 for e in result['elements']), timeFlameAvailable=False),
                basis='字节核算不等于采集无损证明；源码映射率不等于程序覆盖率')


def analyze_calls(events):
    stats, hotspots, edges = {}, {}, Counter()
    root = dict(name='已恢复执行区间', self=0, value=0, children={})
    stack, contexts, previous = [], [], None
    expected_resume = None
    unknown_restarts = 0

    def statistics(fn):
        return stats.setdefault(fn, dict(function=fn, instructions=0, knownExecuted=0,
                                        unknownExecution=0, notTaken=0, calls=0,
                                        closedCalls=0, tailTransfers=0, interruptEntries=0))

    def frame(fn, return_pc=None, origin=None):
        return dict(function=fn, returnPC=return_pc, origin=origin)

    for e in events:
        if e['kind'] != 'instruction':
            t = e['type']
            if t in (1, 2, 6, 7, 8):
                stack, contexts, previous = [], [], None
                expected_resume = None
                unknown_restarts += 1
            elif t == 9:
                if e.get('flags',0)&(1<<12):
                    # Tail chaining has no ordinary nested-call stack contract.
                    stack, contexts, previous = [], [], None
                    unknown_restarts += 1
                contexts.append((stack, previous, e.get('end') if e.get('flags',0)&(1<<6) else None))
                stack = [frame(f'中断 {e["payload"]}')]
                previous = None
            elif t == 10:
                if contexts:
                    stack, previous, expected_resume = contexts.pop()
                else:
                    stack, previous = [], None
                    unknown_restarts += 1
            continue
        fn = e.get('function') or '(未知函数)'
        s = statistics(fn)
        if expected_resume is not None:
            if e['pc'] != (expected_resume&~1):
                stack, previous = [], None
                unknown_restarts += 1
            expected_resume = None
        if not stack:
            stack = [frame('采集前调用栈未知'), frame(fn)]
        if stack[-1]['function'].startswith('中断 '):
            stack.append(frame(fn))
            s['interruptEntries'] += 1
        if previous and previous.get('executed') is True:
            old_fn = previous.get('function') or '(未知函数)'
            if previous.get('flow') == 'call':
                stack.append(frame(fn, previous['pc'] + previous['size'], fn))
                s['calls'] += 1
                edges[(old_fn, fn, 'call')] += 1
            elif previous.get('flow') in ('return', 'branch'):
                match = next((i for i in range(len(stack)-1, -1, -1) if stack[i]['returnPC']==e['pc']), None)
                if match is not None:
                    for closing in stack[match:]:
                        if closing['origin']:
                            statistics(closing['origin'])['closedCalls'] += 1
                    stack = stack[:match]
                elif old_fn != fn and previous.get('flow') == 'branch':
                    s['tailTransfers'] += 1
                    edges[(old_fn, fn, 'tail-transfer')] += 1
                    stack[-1]['function'] = fn
                elif old_fn != fn:
                    stack = [frame('采集前调用栈未知'), frame(fn)]
                    unknown_restarts += 1
        if not stack or stack[-1]['function'] != fn:
            stack = [frame('调用关系未证实'), frame(fn)]
            unknown_restarts += 1
        if len(stack) > 128:
            raise ValueError('调用层级超过 128，拒绝生成可能失真的调用图。')
        s['instructions'] += 1
        s['knownExecuted'] += e.get('executed') is True
        s['unknownExecution'] += e.get('executed') is None
        s['notTaken'] += e.get('executed') is False
        path = [f['function'] for f in stack]
        e['callPath'] = path
        node = root
        node['value'] += 1
        for name in path:
            node = node['children'].setdefault(name, dict(name=name, self=0, value=0, children={}))
            node['value'] += 1
        node['self'] += 1
        key = (fn, e.get('file', ''), e.get('line'))
        hot = hotspots.setdefault(key, dict(function=fn, file=e.get('file', ''), line=e.get('line'), records=0, unknown=0, pc=e['pc']))
        hot['records'] += 1
        hot['unknown'] += e.get('executed') is None
        previous = e
    total_calls = sum(s['calls'] for s in stats.values())
    for s in stats.values():
        s['openCalls'] = max(0, s['calls']-s['closedCalls'])
        s['callPercent'] = 100*s['calls']/total_calls if total_calls else 0
    def serialize(node):
        return {**node, 'children':[serialize(child) for child in node['children'].values()]}
    return dict(functions=sorted(stats.values(), key=lambda s:s['instructions'], reverse=True),
                hotspots=sorted(hotspots.values(),key=lambda h:h['records'],reverse=True),
                flame=serialize(root), observedCalls=total_calls, unknownStackRestarts=unknown_restarts,
                edges=[dict(caller=a, callee=b, kind=k, count=n) for (a,b,k),n in edges.items()],
                weight='路径指令记录数（含未成立/未知状态），不是耗时', callsPerSecond=None,
                rateReason='缺少覆盖可信执行区间的时间基准，暂不计算调用/秒')


def enrich(result, image=None):
    by_element = {(e['type'],e['offset']):e for e in result['elements']}
    for event in result['events']:
        if event['kind']=='event':
            element=by_element.get((event['type'],event['offset']))
            if element:
                for key in ('start','end','flags'):
                    event[key]=element.get(key,0)
    if image is not None:
        mark_execution(result['events'], possible_predicates(image,result['events']))
    elif not all('executionState' in e for e in result['events'] if e['kind']=='instruction'):
        mark_execution(result['events'])
    result['quality'] = byte_accounting(result)
    result['analysis'] = analyze_calls(result['events'])
    result['summary']['executed'] = sum(e['kind']=='instruction' and e.get('executed') is True for e in result['events'])
    result['summary']['unknownExecution'] = result['quality']['unknownExecution']
    result['summary']['packetIssues'] = result['quality']['packetIssues']
    result['summary']['functions'] = dict(Counter(e.get('function') or '(未知函数)' for e in result['events'] if e['kind']=='instruction' and e.get('executed') is True))
    result['version'] = 3
    return result

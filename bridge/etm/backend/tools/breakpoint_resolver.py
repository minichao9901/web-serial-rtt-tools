"""按 ELF 符号和 DWARF 精确解析断点；不猜测相邻源码行。"""
import re
import bisect
from pathlib import PurePosixPath
from capstone import Cs, CS_ARCH_ARM, CS_MODE_THUMB, CS_MODE_MCLASS


def resolve_breakpoint(image, spec):
    text = re.sub(r'^(?:b|break)\s+', '', str(spec).strip())
    executable = [(s['p_vaddr'], s['p_vaddr'] + s['p_filesz'])
                  for s in image.elf.iter_segments() if s['p_type'] == 'PT_LOAD' and s['p_flags'] & 1]
    decoder = Cs(CS_ARCH_ARM, CS_MODE_THUMB | CS_MODE_MCLASS)
    symbols = image.elf.get_section_by_name('.symtab')
    mappings = sorted((s['st_value'], s.name[1]) for s in symbols.iter_symbols()
                      if re.fullmatch(r'\$[tda](?:\..*)?', s.name)) if symbols else []
    mapping_starts = [a for a, _ in mappings]
    starts = set()
    for address, size, _ in image.functions:
        if any(a <= address < b for a, b in executable):
            boundaries = sorted({address, address + size, *(a for a, _ in mappings if address < a < address + size)})
            for begin, end in zip(boundaries, boundaries[1:]):
                index = bisect.bisect_right(mapping_starts, begin) - 1
                if index >= 0 and mappings[index][1] != 't':
                    continue  # literal pools / ARM code are not Cortex-M Thumb instruction starts
                starts.update(i.address for i in decoder.disasm(image.read(begin, end - begin), begin))
    def candidate(address, label):
        if address not in starts:
            raise ValueError('该位置不是 ELF 中可确认的指令起点')
        function, file, line = image.location(address)
        return dict(address=address, label=label, function=function, file=file, line=line)
    raw = re.fullmatch(r'\*?(0x[0-9a-fA-F]+)', text)
    if raw:
        address = int(raw[1], 16)
        if address & 1:
            raise ValueError('指令断点地址必须半字对齐')
        return [candidate(address, f'0x{address:08x}')]
    match = re.fullmatch(r'(.+):(\d+)', text)
    if not match:
        functions = [(a, n) for a, _, n in image.functions if n == text]
        if not functions:
            raise ValueError('未找到函数；支持 b 函数、b 文件:行、b 函数:行、b *0x地址')
        return [candidate(a, n) for a, n in functions]
    name, line = match[1].replace('\\', '/'), int(match[2])
    if line < 1:
        raise ValueError('源码行号必须大于零')
    if not image.lines:
        raise ValueError('该 ELF 没有 DWARF 行号信息；请使用函数或指令地址')
    paths = {file for _, file, _ in image.lines.values() if file}
    matched = {p for p in paths if p.casefold() == name.casefold() or p.casefold().endswith('/' + name.casefold())}
    if not matched:
        for address, _, function in image.functions:
            if function == name:
                file = image.location(address)[1]
                if file:
                    matched.add(file)
    if not matched:
        raise ValueError('找不到该源文件或函数；可写完整文件名，例如 main.c:199')
    addresses = sorted({address for address, (_, file, number) in image.lines.items()
                        if file in matched and number == line and address in starts})
    if not addresses:
        raise ValueError(f'第 {line} 行没有可下断点的机器码，可能为空行或已被优化；不会替换成邻近行')
    return [candidate(a, f'{PurePosixPath(image.location(a)[1]).name}:{line}') for a in addresses]

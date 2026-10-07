/** Resolve a fixed-address C array element using DWARF, without expanding the
 * complete array or evaluating user expressions as JavaScript. */
import { DEFAULT_RAM, SCALARS } from '../elf/dwarf.js';

export function arrayElementChannels(dwarf, expression, { ram = DEFAULT_RAM } = {}){
  if (!dwarf) throw new Error('请先载入带 DWARF 类型信息的 ELF');
  const text = String(expression || '').trim();
  const rootMatch = /^([A-Za-z_$][\w$]*)/.exec(text);
  if (!rootMatch) throw new Error('请输入 数组[下标] 或 结构体数组[下标].成员');
  const root = dwarf.varType(rootMatch[1]);
  if (!root) throw new Error(`ELF 中没有变量 ${rootMatch[1]}`);
  if (root.addr == null || !root.type) throw new Error(root.reason || '变量没有固定地址');
  const rootEnd = root.addr + root.type.size;
  if (!Number.isSafeInteger(rootEnd) || rootEnd > 0x100000000) throw new Error('变量大小或地址范围无效');
  let type = root.type, addr = root.addr, name = root.name, rest = text.slice(rootMatch[0].length), indexed = false;
  let steps = 0;
  while (rest){
    if (++steps > 32) throw new Error('成员路径太长');
    const index = /^\[(-?\d+)\]/.exec(rest), member = /^\.([A-Za-z_$][\w$]*)/.exec(rest);
    if (index){
      if (type.kind !== 'array') throw new Error(`${name} 不是数组`);
      if (type.unsupportedLayout) throw new Error(`${name} 的数组布局暂不支持`);
      const i = Number(index[1]), lb = type.lowerBound ?? 0, count = type.count, stride = type.elem?.size;
      if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(stride) || stride < 1)
        throw new Error(`${name} 的数组长度或元素大小无法确定`);
      if (!Number.isSafeInteger(i) || i < lb || i - lb >= count)
        throw new Error(`${name} 下标越界：允许 ${lb}～${lb + count - 1}`);
      addr += (i - lb) * stride;
      name += `[${i}]`; type = type.elem; rest = rest.slice(index[0].length); indexed = true;
    } else if (member){
      if (type.kind !== 'struct' && type.kind !== 'union') throw new Error(`${name} 不是结构体`);
      const m = type.members.find(m => m.name === member[1]);
      if (!m) throw new Error(`${name} 没有成员 ${member[1]}`);
      if (m.reason || !Number.isSafeInteger(m.offset) || m.bitSize != null)
        throw new Error(m.reason || '位域暂不支持直接采样');
      addr += m.offset; name += `.${m.name}`; type = m.type; rest = rest.slice(member[0].length);
    } else throw new Error('路径格式错误，请使用 数组[下标].成员，不支持运算或指针跟踪');
    if (!type || !Number.isSafeInteger(addr) || addr < root.addr || addr + type.size > rootEnd)
      throw new Error('元素地址超出变量范围');
  }
  if (!indexed) throw new Error('请指定数组下标，例如 数组[0]');
  if (type.kind === 'array') throw new Error('还有一维数组，请继续填写下标，例如 数组[0][0]');
  const wins = Array.isArray(ram[0]) ? ram : [ram], channels = [];
  const leaves = (t, at, path, depth) => {
    if (depth > 8) throw new Error('结构体嵌套太深，请指定具体成员');
    if (t?.kind === 'struct' || t?.kind === 'union'){
      for (const m of t.members || []){
        if (m.reason || m.bitSize != null || !Number.isSafeInteger(m.offset)) continue;
        leaves(m.type, at + m.offset, `${path}.${m.name}`, depth + 1);
      }
    } else if (t?.kind === 'scalar' && SCALARS[t.scalar]?.size === t.size){
      if (!Number.isSafeInteger(at) || at < root.addr || at + t.size > rootEnd ||
          !wins.some(([lo, hi]) => at >= lo && at + t.size <= hi)) throw new Error(`${path} 不在可采样 RAM 范围`);
      channels.push({ name: path, label: path, addr: at, size: t.size, scalar: t.scalar,
                      typeName: t.name || t.scalar, group: root.name, path });
      if (channels.length > 256) throw new Error('成员过多，请指定具体成员后添加');
    }
  };
  leaves(type, addr, name, 0);
  if (!channels.length) throw new Error('该元素没有可直接采样的标量成员（指针、位域或不支持的类型）');
  return channels;
}

/**
 * CMSIS-SVD 的小型、只读解析器。
 *
 * 调试器页面不依赖第三方 XML 包：浏览器里没有 Node 的 XML 模块，用户选的
 * SVD 也可能来自本地文件。因此这里使用一个有边界的 XML tokenizer，仅读取
 * device/peripheral/register/field 这几层，足够覆盖 CMSIS-SVD 1.1/1.3 的
 * 外设寄存器描述，同时也能在 Node 自测里直接解析同一份文件。
 */

const entity = (s) => String(s || '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, k) => {
  const x = String(k).toLowerCase();
  if (x === 'amp') return '&';
  if (x === 'lt') return '<';
  if (x === 'gt') return '>';
  if (x === 'quot') return '"';
  if (x === 'apos') return "'";
  if (x.startsWith('#x')) return String.fromCodePoint(parseInt(x.slice(2), 16));
  if (x.startsWith('#')) return String.fromCodePoint(parseInt(x.slice(1), 10));
  return _;
});

const clean = (s) => entity(String(s || '').replace(/\s+/g, ' ').trim());

function xmlTree(text){
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<!\[[\s\S]*?\]\]>|<[^>]*>/g;
  let at = 0, m;
  const addText = s => { if (s) stack[stack.length - 1].text += entity(s); };
  while ((m = re.exec(String(text || '')))){
    addText(String(text || '').slice(at, m.index));
    const raw = m[0]; at = re.lastIndex;
    if (raw.startsWith('<!--') || raw.startsWith('<![CDATA[')){
      if (raw.startsWith('<![CDATA[')) addText(raw.slice(9, -3));
      continue;
    }
    if (/^<\?/.test(raw) || /^<!/.test(raw)) continue;
    if (/^<\//.test(raw)){ if (stack.length > 1) stack.pop(); continue; }
    const body = raw.slice(1, -1).replace(/\/\s*$/, '').trim();
    const name = (body.match(/^([^\s/>]+)/) || [])[1];
    if (!name) continue;
    const attrs = {};
    const rest = body.slice(name.length);
    const ar = /([^\s=]+)\s*=\s*("[^"]*"|'[^']*')/g;
    let a;
    while ((a = ar.exec(rest))) attrs[a[1]] = entity(a[2].slice(1, -1));
    const n = { name, attrs, children: [], text: '' };
    stack[stack.length - 1].children.push(n);
    if (!/\/\s*$/.test(raw.slice(0, -1))) stack.push(n);
  }
  addText(String(text || '').slice(at));
  return root;
}

const kids = (n, name) => (n?.children || []).filter(x => x.name === name);
const kid = (n, name) => kids(n, name)[0] || null;
const val = (n, name, fallback = '') => {
  const x = kid(n, name);
  return x ? clean(x.text) : fallback;
};

// Vendor files reuse whole peripherals (GPIOB from GPIOA, TIM8 from TIM1, ...).
// Resolve before decoding so a derived instance keeps its own base address.
function resolvePeripherals(nodes){
  const names=new Map(nodes.map(n=>[val(n,'name'),n])),resolved=new Map(),visiting=new Set();
  const resolve=n=>{
    if(resolved.has(n))return resolved.get(n);
    if(visiting.has(n))throw Error('SVD 外设继承循环：'+val(n,'name'));
    visiting.add(n);let result=n;
    if(n.attrs.derivedFrom){
      const parent=names.get(n.attrs.derivedFrom);
      if(!parent)throw Error('SVD 找不到继承外设：'+n.attrs.derivedFrom);
      const base=resolve(parent),ownNames=new Set(n.children.map(c=>c.name));
      result={...n,children:[...base.children.filter(c=>!ownNames.has(c.name)),...n.children]};
    }
    visiting.delete(n);resolved.set(n,result);return result;
  };
  return nodes.map(resolve);
}

export function svdNumber(value, fallback = 0){
  const s = clean(value);
  if (!s) return fallback;
  const neg = /^-/.test(s);
  const body = s.replace(/^[+-]/, '').replace(/_/g, '');
  const n = /^0x/i.test(body) ? parseInt(body.slice(2), 16) : Number(body);
  return Number.isFinite(n) ? (neg ? -n : n) : fallback;
}

function dimIndices(node){
  const dim = svdNumber(val(node, 'dim'), 0);
  if (!dim) return [null];
  const spec = val(node, 'dimIndex', '0-' + (dim - 1));
  const out = [];
  for (const part of spec.split(',')){
    const p = part.trim();
    const r = p.match(/^(.+?)\s*-\s*(.+)$/);
    if (!r){ out.push(p); continue; }
    const a = r[1], b = r[2];
    const na = Number(a), nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)){
      const step = na <= nb ? 1 : -1;
      for (let i = na; step > 0 ? i <= nb : i >= nb; i += step) out.push(String(i));
    } else if (a.length === 1 && b.length === 1){
      const aa = a.charCodeAt(0), bb = b.charCodeAt(0), step = aa <= bb ? 1 : -1;
      for (let i = aa; step > 0 ? i <= bb : i >= bb; i += step) out.push(String.fromCharCode(i));
    }
  }
  return out.length ? out.slice(0, dim) : Array.from({ length: dim }, (_, i) => String(i));
}

const subst = (s, index) => index == null ? clean(s) : clean(String(s || '').replace(/%s/g, index));

function parseField(n, inheritedAccess){
  const bitOffset = val(n, 'bitOffset', '');
  const bitWidth = val(n, 'bitWidth', '');
  let lsb = bitOffset === '' ? svdNumber(val(n, 'lsb'), 0) : svdNumber(bitOffset, 0);
  let width = bitWidth === '' ? 0 : svdNumber(bitWidth, 0);
  if (!width && val(n, 'msb', '') !== '') width = svdNumber(val(n, 'msb'), lsb) - lsb + 1;
  if (!width){
    const range = val(n, 'bitRange', '').match(/\[(\d+)\s*:\s*(\d+)\]/);
    if (range){ lsb = Number(range[2]); width = Number(range[1]) - lsb + 1; }
  }
  if (!Number.isInteger(lsb) || !Number.isInteger(width) || lsb < 0 || width < 1 || width > 64) return null;
  const enums = [];
  const ev = kid(n, 'enumeratedValues');
  for (const e of kids(ev, 'enumeratedValue')) enums.push({ name: val(e, 'name'), value: svdNumber(val(e, 'value'), 0), description: val(e, 'description') });
  return { name: val(n, 'name', '(未命名)'), description: val(n, 'description'), lsb, width,
           access: val(n, 'access', inheritedAccess || ''), readAction: val(n,'readAction'), enumeratedValues: enums };
}

function parseRegister(n, inherited){
  const dim = dimIndices(n);
  const step = svdNumber(val(n, 'dimIncrement'), 0);
  return dim.map((idx, i) => {
    const name = subst(val(n, 'name', '寄存器'), idx);
    const offset = svdNumber(val(n, 'addressOffset'), 0) + (idx == null ? 0 : i * step);
    const access = val(n, 'access', inherited.access || 'read-write');
    const fields = kids(kid(n, 'fields'), 'field').map(f => parseField(f, access)).filter(Boolean);
    return { name, description: val(n, 'description'), addressOffset: offset >>> 0,
      size: svdNumber(val(n, 'size'), inherited.size || 32), resetValue: svdNumber(val(n, 'resetValue'), 0) >>> 0,
      access, readAction: val(n,'readAction',inherited.readAction || ''), fields };
  });
}

function parsePeripheral(n, defaults){
  const dim = dimIndices(n), step = svdNumber(val(n, 'dimIncrement'), 0);
  return dim.map((idx, i) => {
    const name = subst(val(n, 'name', '外设'), idx);
    const baseAddress = (svdNumber(val(n, 'baseAddress'), 0) + (idx == null ? 0 : i * step)) >>> 0;
    const registers = [];
    const rn = kid(n, 'registers');
    const inherited={...defaults,size:svdNumber(val(n,'size'),defaults.size),access:val(n,'access',defaults.access),readAction:val(n,'readAction',defaults.readAction || '')};
    for (const r of kids(rn, 'register')) registers.push(...parseRegister(r, inherited));
    return { name, description: val(n, 'description'), groupName: val(n, 'groupName'), baseAddress,
      registers: registers.sort((a, b) => a.addressOffset - b.addressOffset || a.name.localeCompare(b.name)) };
  });
}

export function parseSvdXml(text){
  const tree = xmlTree(text);
  const device = kid(tree, 'device') || tree.children.find(x => x.name === 'device');
  if (!device) throw new Error('SVD 缺少 <device> 根节点');
  const defaults = { size: svdNumber(val(device, 'size'), 32), access: val(device, 'access', 'read-write') };
  const pn = kid(device, 'peripherals');
  const peripherals = [];
  for (const p of resolvePeripherals(kids(pn, 'peripheral'))) peripherals.push(...parsePeripheral(p, defaults));
  if (!peripherals.length) throw new Error('SVD 没有可用的 <peripheral>');
  return { name: val(device, 'name', 'SVD'), version: val(device, 'version'), description: val(device, 'description'),
           width: svdNumber(val(device, 'width'), 32), peripherals };
}

export function decodeSvdRegister(register, raw){
  const width = Math.max(1, Math.min(64, Number(register?.size) || 32));
  const mask = (1n << BigInt(width)) - 1n;
  const value = typeof raw === 'bigint' ? raw & mask : BigInt(raw >>> 0) & mask;
  const fields = (register?.fields || []).map(f => {
    const fm = (1n << BigInt(f.width)) - 1n;
    const v = (value >> BigInt(f.lsb)) & fm;
    const e = f.enumeratedValues?.find(x => BigInt(x.value >>> 0) === v);
    return { ...f, value: Number(v), valueHex: '0x' + v.toString(16).toUpperCase(), enumName: e?.name || '' };
  });
  return { value, valueHex: '0x' + value.toString(16).toUpperCase().padStart(Math.ceil(width / 4), '0'), fields };
}

export function svdSummary(model){
  const regs = model?.peripherals?.reduce((n, p) => n + p.registers.length, 0) || 0;
  return `${model?.name || 'SVD'}：${model?.peripherals?.length || 0} 个外设 / ${regs} 个寄存器`;
}


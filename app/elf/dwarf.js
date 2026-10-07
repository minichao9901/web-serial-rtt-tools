/**
 * DWARF 4 解析（够"变量浏览器 + 采样"用，不做 line table / loclist / DWARF5）。
 *
 * 为什么要它：`static float pid_kp;` 这类**文件级静态变量在 .symtab 里根本看不见**
 * （实测同一份固件：.symtab 24 个 OBJECT，DWARF 里 48 个带固定地址的变量）。
 * 而且只有 DWARF 才知道"这个 4 字节是 float 还是 int32"—— 类型错了波形就是垃圾。
 *
 * 本文件只做三件事：
 *   1. 走 CU/DIE（abbrev + 表单），把**有固定地址的变量**挑出来；
 *   2. 解析类型链（base/typedef/const/volatile/pointer/array/struct/union/enum），
 *      结构体成员按 `DW_AT_data_member_location` 摊平成"一个成员一路"；
 *   3. 把"不能采样的东西"**连原因一起报出来**（被优化掉了？是数组？在 flash 里？）——
 *      界面要能显示这些原因，点了没反应是最糟的体验。
 *
 * 实测依据（`tools/target-firmware/<例程>/build/fw.elf`，与 pyelftools 对过账）：
 *   🚨 这里**千万别写通配路径** `…​/*​/build/…` —— 注释里出现 `*​/` 会当场把块注释截断，
 *      后面几行就变成代码了。真实症状极具误导性：报错指向**几十行之后**的一个模板字符串
 *      （"Unexpected identifier '里没有'"），而真凶在第 15 行。本项目 2026-09-29 踩过。
 *   版本 = **DWARF 4 与 5 都支持**。
 *   · DWARF 4：name=strp|string、type=ref4、location=exprloc|sec_offset、
 *     data_member_location=data1|data2、upper_bound=data1|data2（STM32 那两份快照就是这种）。
 *   · DWARF 5（GCC 11+ 默认，HPM SDK 也是）：CU 头多一个 unit_type 字节；
 *     `strx*`/`addrx*` 是**间接表下标**（要查 `.debug_str_offsets` / `.debug_addr`，
 *     基址来自 CU 的 `DW_AT_str_offsets_base` / `DW_AT_addr_base`，缺省 8）；
 *     名字可能走 `line_strp`（`.debug_line_str`）；全局变量的位置可能是 `DW_OP_addrx`。
 *   → 遇到**没实现的 form** 时 `listSampleable()` 会退回符号表并说明原因，不会整盘失败。
 *
 * 结构：一次遍历建**索引**（按 offset 升序的记录数组），之后所有查询都是 O(log n)/O(1)。
 * 🚨 不要写成"每次要类型的就去全量扫一遍 DIE"—— 那是 O(n²)，小固件看不出、
 *    真工程（几十万 DIE）会卡死。
 *
 * 🚨 **abbrev 表的 code 号是"表内局部"的**：`.debug_abbrev` 里可以有多张表，每个 CU 用
 *    `DW_AT_abbrev_offset` 指向自己的那张，同一个 code 在不同表里可以是完全不同的 tag/form。
 *    本文件第一版把整段合并成一张表（后解析的覆盖先解析的）→ CU 0 的属性按别人的表来读
 *    → 走位失步 → 报"abbrev 里没有 code 23"（而真凶是表用错了）。必须按 offset 分别解析。
 */
import { cstrAt } from './elf.js';

// ---------------------------------------------------------------- 常量
const TAG = {
  array_type: 0x01, class_type: 0x02, enumeration_type: 0x04, formal_parameter: 0x05,
  lexical_block: 0x0b, member: 0x0d, pointer_type: 0x0f, reference_type: 0x10,
  compile_unit: 0x11, structure_type: 0x13, subroutine_type: 0x15, typedef: 0x16,
  union_type: 0x17, inheritance: 0x1c, subrange_type: 0x21, base_type: 0x24,
  const_type: 0x26, enumerator: 0x28, subprogram: 0x2e, variable: 0x34,
  volatile_type: 0x35, restrict_type: 0x37, namespace: 0x39, unspecified_type: 0x3b,
  rvalue_reference_type: 0x42, atomic_type: 0x47, immutable_type: 0x4b,
};
const AT = {
  location: 0x02, name: 0x03, ordering: 0x09, byte_size: 0x0b, bit_offset: 0x0c, bit_size: 0x0d,
  stmt_list: 0x10, low_pc: 0x11, high_pc: 0x12, language: 0x13, comp_dir: 0x1b,
  const_value: 0x1c, lower_bound: 0x22, producer: 0x25, count: 0x37,
  data_member_location: 0x38, decl_file: 0x3a, decl_line: 0x3b, declaration: 0x3c,
  encoding: 0x3e, external: 0x3f, specification: 0x47, type: 0x49,
  bit_stride: 0x2e, upper_bound: 0x2f, abstract_origin: 0x31, byte_stride: 0x51, data_bit_offset: 0x6b,
};
const FORM = {
  addr: 0x01, block2: 0x03, block4: 0x04, data2: 0x05, data4: 0x06, data8: 0x07,
  string: 0x08, block: 0x09, block1: 0x0a, data1: 0x0b, flag: 0x0c, sdata: 0x0d,
  strp: 0x0e, udata: 0x0f, ref_addr: 0x10, ref1: 0x11, ref2: 0x12, ref4: 0x13,
  ref8: 0x14, ref_udata: 0x15, indirect: 0x16, sec_offset: 0x17, exprloc: 0x18,
  flag_present: 0x19,
  // ---- DWARF 5 新增/改号（🚨 0x1b 是 addrx 不是 data16！之前那张表把 0x1b 当 data16，会读错长度）----
  strx: 0x1a, addrx: 0x1b, ref_sup4: 0x1c, strp_sup: 0x1d,
  data16: 0x1e, line_strp: 0x1f, ref_sig8: 0x20, implicit_const: 0x21,
  loclistx: 0x22, rnglistx: 0x23, ref_sup8: 0x24,
  strx1: 0x25, strx2: 0x26, strx3: 0x27, strx4: 0x28,
  addrx1: 0x29, addrx2: 0x2a, addrx3: 0x2b, addrx4: 0x2c,
};
/** DW_AT 里跟 v5 间接表有关的两个基址（缺省 = 8，即 32 位 DWARF 头之后的第一个表项）*/
const AT_STR_OFFSETS_BASE = 0x72, AT_ADDR_BASE = 0x73;
const DW_ATE = { address: 0x01, boolean: 0x02, complex_float: 0x03, float: 0x04,
  signed: 0x05, signed_char: 0x06, unsigned: 0x07, unsigned_char: 0x08 };
const DW_OP_addr = 0x03, DW_OP_plus_uconst = 0x23, DW_OP_addrx = 0xa1;

/** 采样支持的类型表（编码与 HID 0x32 的 type 字节一致，见 docs/scope-page.md §7.1） */
export const SCALARS = {
  u8:  { code: 0, size: 1, signed: false, float: false },
  i8:  { code: 1, size: 1, signed: true,  float: false },
  u16: { code: 2, size: 2, signed: false, float: false },
  i16: { code: 3, size: 2, signed: true,  float: false },
  u32: { code: 4, size: 4, signed: false, float: false },
  i32: { code: 5, size: 4, signed: true,  float: false },
  f32: { code: 6, size: 4, signed: true,  float: true },
  f64: { code: 7, size: 8, signed: true,  float: true },
};

/** 可采样地址窗口：RAM。滤掉 flash/rodata（0x08…）、外设（0x4…），
 *  以及 F4 的 CCM RAM（0x10000000，内核私有总线，AHB-AP 读不到）。 */
export const DEFAULT_RAM = [0x20000000, 0x40000000];

const hex32 = n => '0x' + (n >>> 0).toString(16).padStart(8, '0');

/** 位置表达式（不是 DW_OP_addr 时）→ 人话。这些量**采不了**，但原因要说清楚。 */
function locOpReason(op){
  if (op >= 0x50 && op <= 0x6f) return '在寄存器里（DW_OP_reg*，没有固定地址）';
  if (op >= 0x70 && op <= 0x8f) return '寄存器 + 偏移（DW_OP_breg*，没有固定地址）';
  switch (op){
    case 0x23: return '地址常量 + 偏移（DW_OP_plus_uconst，v1 未支持）';
    case 0x91: return '栈帧相对（DW_OP_fbreg —— 局部变量，没有固定地址）';
    case 0x92: return '静态基址相对（DW_OP_bregx，没有固定地址）';
    case 0x93: case 0x94: case 0x95: case 0x96: return 'TLS 线程局部（没有固定地址）';
    case 0x97: return 'DW_OP_push_object_address（没有固定地址）';
    case 0x9f: return '栈顶解引用（DW_OP_stack_value，没有固定地址）';
    default: return `位置表达式 op=0x${op.toString(16)}（没有固定地址）`;
  }
}

// ---------------------------------------------------------------- 读取器
class R {
  constructor(b, o = 0){ this.b = b; this.o = o; }
  get eof(){ return this.o >= this.b.length; }
  u8(){ return this.b[this.o++]; }
  u16(){ const v = this.b[this.o] | (this.b[this.o + 1] << 8); this.o += 2; return v; }
  u32(){ const b = this.b, o = this.o; this.o += 4;
    return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  u64(){ const lo = this.u32(), hi = this.u32(); return hi * 4294967296 + lo; }
  uleb(){ let r = 0, s = 0, x; do { x = this.u8(); r += (x & 0x7f) * Math.pow(2, s); s += 7; } while (x & 0x80); return r; }
  sleb(){ let r = 0, s = 0, x; do { x = this.u8(); r += (x & 0x7f) * Math.pow(2, s); s += 7; } while (x & 0x80);
    if (s < 32 && (x & 0x40)) r -= Math.pow(2, s); return r; }
  bytes(n){ const v = this.b.subarray(this.o, this.o + n); this.o += n; return v; }
}

// ---------------------------------------------------------------- 主类
export class Dwarf {
  constructor(elf){
    this.elf = elf;
    this.info = elf.data('.debug_info');
    this.abbrevRaw = elf.data('.debug_abbrev');
    this.str = elf.data('.debug_str');
    // DWARF 5 的两张"间接表"（`strx*` / `addrx*` 表单要用；没有就是没用到）
    this.lineStr = elf.data('.debug_line_str');
    this.strOffsets = elf.data('.debug_str_offsets');
    this.addr = elf.data('.debug_addr');
    if (!this.info.length) throw new Error('这个 ELF 没有 .debug_info —— 不是 -g 构建，或者被 strip 过');
    this._abbrCache = null;       // abbrev 表缓存：**按 offset 分表**（key = DW_AT_abbrev_offset）
    this._types = new Map();      // DIE offset → 类型对象（记忆化）
    this._arr = null;             // 索引：按 offset 升序的记录数组
    this._byOff = new Map();
    this.stats = { cu: 0, dies: 0, vars: 0 };
  }

  static available(elf){ return !!(elf.section('.debug_info')?.size); }

  /** 各 CU 的版本号（界面上标出"这份固件的调试信息是 DWARF x"）*/
  versions(){
    const out = [];
    for (const cu of this.cus()) out.push(cu.version);
    return out;
  }

  /**
   * 各 CU 的关键属性：`stmt_list`（行号程序在 .debug_line 里的偏移）、`comp_dir`、`name`。
   * 只读**每个 CU 的根 DIE**（不进子树），所以很便宜 —— 源码行映射（`elf/lines.js`）要靠它：
   * 行号程序自己只有相对路径，且 v<=4 的头里连地址宽度都没有，都得问 CU。
   */
  cuList(){
    const out = [];
    for (const cu of this.cus()){
      try {
        const abbr = this.abbrevAt(cu.abbrevOff);
        const die = this._die(new R(this.info, cu.dieOff), abbr, cu);
        if (!die) continue;
        out.push({
          ...cu,
          name: this.name(die),
          compDir: this.attr(die, AT.comp_dir)?.value || '',
          stmtList: this.num(die, AT.stmt_list),
        });
      } catch { /* 单个 CU 读坏了不影响别的 CU */ }
    }
    return out;
  }

  /** 缩写表（**按 CU 的 DW_AT_abbrev_offset 分别解析**，见下）*/
  abbrevAt(offset){
    if (!this._abbrCache) this._abbrCache = new Map();
    if (this._abbrCache.has(offset)) return this._abbrCache.get(offset);
    const map = new Map();
    const r = new R(this.abbrevRaw, offset);
    while (!r.eof){
      const code = r.uleb();
      if (!code) break;                          // 0 = 这张表结束（后面可能还有别的 CU 的表）
      const tag = r.uleb();
      const children = r.u8() !== 0;
      const attrs = [];
      for (;;){
        const at = r.uleb(), form = r.uleb();
        if (!at && !form) break;
        let ic = null;
        if (form === FORM.implicit_const) ic = r.sleb();
        attrs.push([at, form, ic]);
      }
      map.set(code, { tag, children, attrs });
    }
    this._abbrCache.set(offset, map);
    return map;
  }

  /** 所有缩写的集合（排障用：看看到底有几张表）*/
  abbrevTables(){
    const tables = new Map();
    let o = 0;
    while (o < this.abbrevRaw.length){
      const before = o;
      const map = this.abbrevAt(o);
      tables.set(o, map);
      // 找出这张表结束的位置：重新扫一遍（便宜，排障时才用）
      const r = new R(this.abbrevRaw, o);
      while (!r.eof){
        const code = r.uleb();
        if (!code){ o = r.o; break; }
        r.uleb(); r.u8();
        for (;;){ const at = r.uleb(), f = r.uleb(); if (!at && !f) break; if (f === FORM.implicit_const) r.sleb(); }
      }
      if (o === before) break;
    }
    return tables;
  }

  /** 遍历编译单元头 */
  *cus(){
    const b = this.info;
    let o = 0;
    while (o + 11 < b.length){
      const r = new R(b, o);
      let len = r.u32();
      const is64 = len === 0xffffffff;
      if (is64) len = r.u64();
      if (!len) break;
      const end = r.o + len;
      const version = r.u16();
      let abbrevOff, addrSize, unitType = 0;
      if (version >= 5){
        unitType = r.u8();                       // DW_UT_compile / partial / …
        addrSize = r.u8();
        abbrevOff = r.u32();
      } else {
        abbrevOff = r.u32();
        addrSize = r.u8();
      }
      yield { offset: o, version, abbrevOff, addrSize, unitType, dieOff: r.o, end: Math.min(end, b.length) };
      o = end;
    }
  }

  /** 读一个 DIE；返回 {tag, attrs, offset, hasChildren} 或 null（null DIE）*/
  _die(r, abbr, cu){
    const offset = r.o;
    const code = r.uleb();
    if (!code) return null;
    const a = abbr.get(code);
    if (!a) throw new Error(`.debug_abbrev 里没有 code ${code}（offset ${offset}）—— 文件坏了？`);
    const attrs = new Map();
    for (const [at, form, ic] of a.attrs) attrs.set(at, this._value(r, form, ic, cu));
    return { tag: a.tag, attrs, offset, hasChildren: a.children };
  }

  _value(r, form, ic, cu){
    switch (form){
      case FORM.addr: return { form, value: cu.addrSize === 8 ? r.u64() : r.u32() };
      case FORM.data1: case FORM.flag: return { form, value: r.u8() };
      case FORM.data2: return { form, value: r.u16() };
      case FORM.data4: return { form, value: r.u32() };
      case FORM.data8: return { form, value: r.u64() };
      case FORM.data16: return { form, value: r.bytes(16) };
      case FORM.sdata: return { form, value: r.sleb() };
      case FORM.udata: return { form, value: r.uleb() };
      case FORM.string: { const s = r.o; while (!r.eof && r.b[r.o]) r.o++;
        const v = cstrAt(r.b, s); r.u8(); return { form, value: v }; }
      case FORM.strp: { const off = r.u32(); return { form, value: cstrAt(this.str, off) }; }
      // DWARF 5：名字/路径也可以指向 .debug_line_str
      case FORM.line_strp: { const off = r.u32(); return { form, value: cstrAt(this.lineStr, off) }; }
      /**
       * DWARF 5 的"间接字符串"：`strx*` 给的是 **.debug_str_offsets 里的下标**，
       * 表项才是 .debug_str 的偏移。基址来自 CU 的 `DW_AT_str_offsets_base`（缺省 8）。
       */
      case FORM.strx: case FORM.strx1: case FORM.strx2: case FORM.strx3: case FORM.strx4: {
        const idx = this._idxOf(r, form, FORM.strx, FORM.strx1, FORM.strx2, FORM.strx3);
        const base = cu.strOffsetsBase ?? 8;
        const at = base + idx * 4;
        const off = (at + 4 <= this.strOffsets.length)
          ? (this.strOffsets[at] | (this.strOffsets[at + 1] << 8) | (this.strOffsets[at + 2] << 16) | (this.strOffsets[at + 3] << 24)) >>> 0
          : 0;
        return { form, value: cstrAt(this.str, off) };
      }
      /**
       * DWARF 5 的"间接地址"：`addrx*` 给的是 **.debug_addr 里的下标**（按地址宽度取）。
       * 用在 `DW_AT_low_pc` 与 `DW_OP_addrx` 的位置表达式里。基址缺省 8。
       */
      case FORM.addrx: case FORM.addrx1: case FORM.addrx2: case FORM.addrx3: case FORM.addrx4: {
        const idx = this._idxOf(r, form, FORM.addrx, FORM.addrx1, FORM.addrx2, FORM.addrx3);
        return { form, value: this._addrAtIndex(cu, idx) };
      }
      case FORM.data16: return { form, value: r.bytes(16) };
      case FORM.block1: { const n = r.u8(); return { form, value: r.bytes(n) }; }
      case FORM.block2: { const n = r.u16(); return { form, value: r.bytes(n) }; }
      case FORM.block4: { const n = r.u32(); return { form, value: r.bytes(n) }; }
      case FORM.block: { const n = r.uleb(); return { form, value: r.bytes(n) }; }
      case FORM.exprloc: { const n = r.uleb(); return { form, value: r.bytes(n) }; }
      case FORM.flag_present: return { form, value: 1 };
      case FORM.sec_offset: return { form, value: r.u32() };      // 位置/范围列表偏移
      case FORM.ref1: return { form, value: cu.offset + r.u8() };
      case FORM.ref2: return { form, value: cu.offset + r.u16() };
      case FORM.ref4: return { form, value: cu.offset + r.u32() };
      case FORM.ref8: return { form, value: cu.offset + r.u64() };
      case FORM.ref_udata: return { form, value: cu.offset + r.uleb() };
      case FORM.ref_addr: return { form, value: r.u32(), unresolved: true };
      // DWARF4 的 type unit 签名（GCC -fdebug-types-section 会出现）：
      // 8 字节签名我们不解析类型，但**必须把游标跳过**，否则后面全乱。
      // 🚨 这里原来写的是 `r.skip(8)` —— R 类根本没这个方法，遇到它就 TypeError
      //    把"支持的表单"变成解析崩溃（代码审查抓到的）。
      case FORM.ref_sig8: r.bytes(8); return { form, value: null };
      // v5 里这两族是"列表下标"，我们不做列表解析，但**必须把操作数读掉**，否则游标错位
      case FORM.loclistx: return { form, value: r.uleb(), listIndex: true };
      case FORM.rnglistx: return { form, value: r.uleb(), listIndex: true };
      case FORM.ref_sup4: case FORM.strp_sup: return { form, value: r.u32(), unresolved: true };
      case FORM.ref_sup8: return { form, value: r.u64(), unresolved: true };
      case FORM.implicit_const: return { form, value: ic };
      case FORM.indirect: { const f2 = r.uleb(); return this._value(r, f2, ic, cu); }
      default:
        throw new Error(`不支持的 DWARF form 0x${form.toString(16)}`);
    }
  }

  /** `strx`/`addrx` 这一族的"下标"读取：无后缀 = ULEB，带数字后缀 = 固定 1/2/3/4 字节 */
  _idxOf(r, form, base, f1, f2, f3){
    if (form === base) return r.uleb();
    if (form === f1) return r.u8();
    if (form === f2) return r.u16();
    if (form === f3) return r.u8() | (r.u8() << 8) | (r.u8() << 16);
    return r.u32();
  }

  /** 取 `.debug_addr` 里第 idx 个地址（按 CU 的地址宽度）*/
  _addrAtIndex(cu, idx){
    const base = cu.addrBase ?? 8;
    const w = cu.addrSize === 8 ? 8 : 4;
    const at = base + idx * w;
    if (at + w > this.addr.length) return 0;
    if (w === 4) return (this.addr[at] | (this.addr[at + 1] << 8) | (this.addr[at + 2] << 16) | (this.addr[at + 3] << 24)) >>> 0;
    const lo = (this.addr[at] | (this.addr[at + 1] << 8) | (this.addr[at + 2] << 16) | (this.addr[at + 3] << 24)) >>> 0;
    const hi = (this.addr[at + 4] | (this.addr[at + 5] << 8) | (this.addr[at + 6] << 16) | (this.addr[at + 7] << 24)) >>> 0;
    return hi * 4294967296 + lo;
  }

  /** 一次遍历建索引（O(n)）。记录：{offset, end, tag, attrs, parent, depth, cu} */
  index(){
    if (this._arr) return this;
    const arr = [], byOff = new Map(), stack = [];
    for (const cu of this.cus()){
      this.stats.cu++;
      const abbr = this.abbrevAt(cu.abbrevOff);      // 🚨 每个 CU 用自己的那张表
      const r = new R(this.info, cu.dieOff);
      stack.length = 0;
      while (r.o < cu.end){
        const die = this._die(r, abbr, cu);
        if (!die){                                   // null DIE：兄弟链结束
          const top = stack.pop();
          if (top) top.end = r.o - 1;
          continue;
        }
        this.stats.dies++;
        if (this.stats.dies > 4_000_000) throw new Error('DIE 数量异常（>400 万）：调试信息有问题');
        /**
         * DWARF 5：`strx*`/`addrx*` 两族表单要拿 CU 的 `DW_AT_str_offsets_base` /
         * `DW_AT_addr_base` 才能定位。这两个属性一般出现在**头一个 DIE**（CU DIE）上，
         * 而子 DIE 在其后 —— 所以在这里见到就记到 cu 上，后面的 DIE 自动用得上。
         * 没有这个属性时按规范缺省 8（32 位 DWARF 头之后的第一项）。
         */
        const sb = die.attrs.get(AT_STR_OFFSETS_BASE), ab = die.attrs.get(AT_ADDR_BASE);
        if (sb && typeof sb.value === 'number') cu.strOffsetsBase = sb.value;
        if (ab && typeof ab.value === 'number') cu.addrBase = ab.value;
        const rec = { offset: die.offset, end: cu.end, tag: die.tag, attrs: die.attrs,
                      parent: stack.length ? stack[stack.length - 1].offset : -1,
                      depth: stack.length, cu, children: die.hasChildren };
        arr.push(rec);
        byOff.set(rec.offset, rec);
        if (die.hasChildren) stack.push(rec);
      }
    }
    // 叶子的 end = 下一条记录的 offset（父节点已经在 null DIE 处填好了）
    for (let i = 0; i < arr.length; i++){
      if (!arr[i].children && i + 1 < arr.length) arr[i].end = arr[i + 1].offset;
    }
    this._arr = arr;
    this._byOff = byOff;
    return this;
  }

  /** 直接子 DIE（利用索引区间，O(子树大小)）*/
  childrenOf(rec){
    this.index();
    const out = [];
    const arr = this._arr;
    let i = upperBound(arr, rec.offset);
    for (; i < arr.length && arr[i].offset < rec.end; i++){
      if (arr[i].parent === rec.offset) out.push(arr[i]);
    }
    return out;
  }

  dieAt(offset){ this.index(); return this._byOff.get(offset) || null; }
  attr(rec, at){ return rec?.attrs.get(at); }
  name(rec){ const a = rec?.attrs.get(AT.name); return a && typeof a.value === 'string' ? a.value : ''; }
  num(rec, at){ const a = rec?.attrs.get(at); return a && typeof a.value === 'number' ? a.value : null; }

  /**
   * 把 `DW_AT_specification` / `DW_AT_abstract_origin` 链上的属性**并进来**（缺什么补什么）。
   *
   * 为什么必须做：GCC 给"定义"发的 DIE 可能**只有地址没有名字/类型**，名字和类型在它引用的
   * "声明" DIE 上（实测：`_SEGGER_RTT` 在 SEGGER_RTT.c 里是 `SECTION(...)` 宏包着的定义，
   * 定义 DIE 无名无类型、地址 0x200000c；声明 DIE 有名字和 `SEGGER_RTT_CB` 类型）。
   * 不做这一步的表现是：一个**无名**变量被悄悄丢掉 —— 而它恰恰是 RTT 控制块。
   */
  merged(rec){
    if (!rec) return null;
    if (rec._merged) return rec._merged;
    const attrs = new Map(rec.attrs);
    let cur = rec, depth = 0;
    while (depth++ < 8){
      const spec = this.num(cur, AT.specification) ?? this.num(cur, AT.abstract_origin);
      if (spec == null) break;
      const target = this.dieAt(spec);
      if (!target) break;
      for (const [k, v] of target.attrs){
        // 🚨 不要从"声明"那侧继承 DW_AT_declaration —— 否则定义 DIE 会被自己当成声明丢掉
        if (k === AT.declaration) continue;
        if (!attrs.has(k)) attrs.set(k, v);
      }
      cur = target;
    }
    const out = { offset: rec.offset, end: rec.end, tag: rec.tag, parent: rec.parent,
                  depth: rec.depth, cu: rec.cu, children: rec.children, attrs };
    rec._merged = out;
    return out;
  }

  /**
   * 解析类型链（记忆化）。
   * → {kind:'scalar'|'struct'|'union'|'array'|'pointer'|'unknown', size, scalar?, members?, elem?, count?}
   */
  type(refOff){
    if (refOff == null) return { kind: 'unknown', size: 0, reason: '没有 DW_AT_type' };
    if (this._types.has(refOff)) return this._types.get(refOff);
    const rec = this.dieAt(refOff);
    const out = rec ? this._typeOf(rec) : { kind: 'unknown', size: 0, reason: '类型 DIE 找不到（可能被裁剪）' };
    this._types.set(refOff, out);
    return out;
  }

  _typeOf(rec){
    const size = () => this.num(rec, AT.byte_size) ?? 0;
    switch (rec.tag){
      case TAG.base_type: {
        const enc = this.num(rec, AT.encoding);
        const sz = size() || 1;
        const nm = this.name(rec);
        let key = null;
        if (enc === DW_ATE.float || enc === DW_ATE.complex_float) key = sz === 4 ? 'f32' : sz === 8 ? 'f64' : null;
        else if (enc === DW_ATE.boolean) key = sz === 1 ? 'u8' : null;
        else if (enc === DW_ATE.signed || enc === DW_ATE.signed_char) key = sz === 1 ? 'i8' : sz === 2 ? 'i16' : sz === 4 ? 'i32' : null;
        else if (enc === DW_ATE.unsigned || enc === DW_ATE.unsigned_char) key = sz === 1 ? 'u8' : sz === 2 ? 'u16' : sz === 4 ? 'u32' : null;
        if (!key){
          return { kind: 'scalar', size: sz, scalar: null, name: nm || '?',
                   reason: `类型 ${nm || '?'}（${sz} B）不在采样类型表里（v1 支持 u8/u16/u32、i8/i16/i32、f32/f64）` };
        }
        return { kind: 'scalar', size: sz, scalar: key, name: nm };
      }
      case TAG.typedef: {
        const t = this.type(this.num(rec, AT.type));
        return { ...t, alias: this.name(rec) || t.alias };
      }
      case TAG.const_type: case TAG.volatile_type: case TAG.restrict_type:
      case TAG.atomic_type: case TAG.immutable_type:
        return this.type(this.num(rec, AT.type));
      case TAG.pointer_type: case TAG.reference_type: case TAG.rvalue_reference_type:
        return { kind: 'pointer', size: size() || 4, to: this.num(rec, AT.type) };
      case TAG.enumeration_type: {
        const sz = size() || 4;
        const key = sz === 1 ? 'u8' : sz === 2 ? 'u16' : sz <= 4 ? 'u32' : null;
        const nm = this.name(rec) || 'enum';
        return key ? { kind: 'scalar', size: sz, scalar: key, name: nm, enum: true }
                   : { kind: 'scalar', size: sz, scalar: null, name: nm, reason: `${sz} 字节的枚举不在采样类型表里` };
      }
      case TAG.structure_type: case TAG.class_type: case TAG.union_type: {
        const members = [];
        for (const d of this.childrenOf(rec)){
          if (d.tag !== TAG.member) continue;
          const off = this._memberOffset(d);
          const bits = this.num(d, AT.bit_size);
          const mtype = this.type(this.num(d, AT.type));
          const bitOff = bits ? this._dataBitOffset(d, off, mtype, bits) : null;
          members.push({
            name: this.name(d) || '(匿名)',
            offset: off,
            type: mtype,
            bitSize: bits ?? null,
            /** 从**结构体首字节**起算的位偏移（有了它界面就能把位域解出来）；读不出来时为 null */
            bitOffset: bitOff,
            reason: off === null ? '成员偏移不是常量（DWARF 表达式）'
                  : (bits && bitOff == null ? '位域（偏移读不出来）' : null),
          });
        }
        return { kind: rec.tag === TAG.union_type ? 'union' : 'struct', size: size(),
                 name: this.name(rec), members };
      }
      case TAG.array_type: {
        const elem = this.type(this.num(rec, AT.type));
        const dims = [];
        for (const d of this.childrenOf(rec)){
          if (d.tag !== TAG.subrange_type) continue;
          const ub = this.num(d, AT.upper_bound), c = this.num(d, AT.count), lb = this.num(d, AT.lower_bound) ?? 0;
          dims.push({ count: c ?? (ub != null ? ub - lb + 1 : null), lowerBound: lb });
        }
        // C multidimensional arrays have several subranges on one DIE. Build
        // the inner dimensions first so a[i][j] uses the complete row stride.
        let t = elem;
        for (let i = dims.length - 1; i >= 0; i--){
          const { count, lowerBound } = dims[i];
          t = { kind: 'array', elem: t, count, lowerBound,
                size: count != null ? count * (t.size || 0) : 0 };
        }
        if (!dims.length) t = { kind: 'array', elem, count: null, lowerBound: 0, size: 0 };
        return { ...t, size: size() || t.size,
                 // Non-contiguous or column-major layouts need a separate
                 // address calculation. Do not silently apply C row strides.
                 unsupportedLayout: !!rec.attrs.get(AT.byte_stride) || !!rec.attrs.get(AT.bit_stride) || this.num(rec, AT.ordering) === 1 };
      }
      case TAG.unspecified_type:
        return { kind: 'unknown', size: size(), reason: `unspecified_type（${this.name(rec) || '?'}）` };
      case TAG.subroutine_type:
        return { kind: 'unknown', size: 0, reason: '函数类型' };
      default:
        return { kind: 'unknown', size: size(), reason: `未处理的 tag 0x${rec.tag.toString(16)}` };
    }
  }

  /**
   * 位域成员：算出**从结构体首字节起算**的位偏移（小端 MCU 的算法）。
   *
   * 两个标准写法都得认：
   *   · DWARF ≥ 4：`DW_AT_data_bit_offset` 本来就是"从结构体起算"，直接用；
   *   · DWARF ≤ 3：`DW_AT_bit_offset` 是"从**存储单元的最高位**起算"，
   *     小端下换算成 `成员字节偏移×8 + (存储单元位数 - bit_offset - bit_size)`。
   *     存储单元位数取成员的声明类型大小（`uint32_t x:4` 就是 32 位）。
   */
  _dataBitOffset(rec, memberOffset, type, bitSize){
    const dbo = this.num(rec, AT.data_bit_offset);
    if (dbo != null) return dbo;
    const bo = this.num(rec, AT.bit_offset);
    if (bo == null || memberOffset == null) return null;
    const container = (type?.size || 4) * 8;
    return memberOffset * 8 + Math.max(0, container - bo - bitSize);
  }

  /**
   * 按**名字**取一个全局/静态变量的地址与**完整类型树**（调试页的结构体监视靠它）。
   *
   * 与 `listVariables()` 的区别：那边只摊平"能采样的叶子"（结构体成员变成 `g_pack.u_hi` 一路），
   * 这里要的是**整棵树**（结构体 / 联合 / 数组本身也要），界面才能做可展开的树。
   *
   * @returns {{name:string, addr:number|null, type:object|null, reason:string|null}|null}
   */
  varType(name){
    const want = String(name || '').trim();
    if (!want) return null;
    if (!this._varCache){
      this._varCache = new Map();
      this.index();
      for (const rec0 of this._arr){
        if (rec0.tag !== TAG.variable) continue;
        const rec = this.merged(rec0);
        const nm = this.name(rec);
        if (!nm || rec.attrs.get(AT.declaration)) continue;
        if (this._varCache.has(nm)) continue;             // 同名以第一条为准（与符号表口径一致）
        this._varCache.set(nm, rec);
      }
    }
    const rec = this._varCache.get(want);
    if (!rec) return null;
    const fa = this.fixedAddr(rec);
    if (fa.addr == null) return { name: want, addr: null, type: null, reason: fa.reason };
    return { name: want, addr: fa.addr >>> 0, type: this.type(this.num(rec, AT.type)), reason: null };
  }

  _memberOffset(rec){
    const a = rec.attrs.get(AT.data_member_location);
    if (!a) return 0;
    if (typeof a.value === 'number') return a.value;
    if (a.value instanceof Uint8Array){                    // exprloc：只认 DW_OP_plus_uconst
      const e = a.value;
      if (e[0] === DW_OP_plus_uconst) return new R(e, 1).uleb();
    }
    return null;
  }

  /** 从 DW_AT_location 的 exprloc 里取固定地址（`DW_OP_addr <addr>`；v5 也常见 `DW_OP_addrx <idx>`）*/
  fixedAddr(rec){
    const loc = rec.attrs.get(AT.location);
    if (!loc) return { addr: null, reason: '没有 DW_AT_location（只是声明 / 被优化掉）' };
    if (loc.form === FORM.sec_offset) return { addr: null, reason: '位置列表（被优化进寄存器/栈，没有固定地址）' };
    const e = loc.value;
    const as = rec.cu.addrSize;
    if (!(e instanceof Uint8Array) || e.length < 1) return { addr: null, reason: '位置表达式看不懂' };
    /**
     * DWARF 5 的 `DW_OP_addrx`(0xa1)：操作数是 **.debug_addr 里的下标**（ULEB128），
     * 地址本身要按 CU 的 `DW_AT_addr_base` 去查表。GCC 在 `-gdwarf-5` 下常这么发全局变量，
     * 只认 `DW_OP_addr` 的话会把它们全判成"没有固定地址"（看着像变量凭空消失）。
     */
    if (e[0] === DW_OP_addrx){
      let idx = 0, s = 0, i = 1, x;
      do { x = e[i++]; idx += (x & 0x7f) * Math.pow(2, s); s += 7; } while (x & 0x80);
      return { addr: this._addrAtIndex(rec.cu, idx) >>> 0, tail: e.length > i, via: 'addrx' };
    }
    if (e[0] !== DW_OP_addr) return { addr: null, reason: locOpReason(e[0]) };
    if (e.length < 1 + as) return { addr: null, reason: '位置表达式看不懂' };
    let addr = 0;
    for (let i = as - 1; i >= 0; i--) addr = addr * 256 + e[1 + i];
    return { addr: addr >>> 0, tail: e.length > 1 + as };
  }

  /**
   * 列出可采样的"通道"。
   * @param {{ram?:[number,number]|[number,number][], maxDepth?:number}} opts
   *   `ram` 可以是单个窗口 `[lo,hi]`（STM32 传统写法），也可以是**多个窗口**的数组
   *   （RISC-V/HPM 的 RAM 散落在 ILM 0x0 与 SRAM 0x01200000 两处，一个窗口盖不住）。
   */
  listVariables({ ram = DEFAULT_RAM, maxDepth = 4 } = {}){
    this.index();
    const sampleable = [], skipped = [], arrays = [];
    const wins = Array.isArray(ram[0]) ? ram : [ram];
    const inRam = a => wins.some(([lo, hi]) => a >= lo && a < hi);
    const winTxt = () => wins.map(([lo, hi]) => `${hex32(lo)}~${hex32(hi)}`).join(' / ');

    const leaves = (name, addr, type, group, depth) => {
      if (depth > maxDepth){ skipped.push({ name, reason: '结构体嵌套太深（>4 层）' }); return; }
      if (!type || type.kind === 'unknown'){ skipped.push({ name, size: type?.size, reason: type?.reason || '类型未知' }); return; }
      if (type.kind === 'pointer'){ skipped.push({ name, size: type.size, reason: '指针（要指针跟踪才能采，v1 不做）' }); return; }
      if (type.kind === 'array'){
        const c = type.count != null ? `${type.count} 个` : '? 个';
        if (inRam(addr)) arrays.push({ name, addr, count: type.count, lowerBound: type.lowerBound ?? 0 });
        skipped.push({ name, size: type.size, reason: `数组（${c}${type.elem?.name || ''}）—— 在数组元素栏按下标添加` });
        return;
      }
      if (type.kind === 'struct' || type.kind === 'union'){
        if (!type.members?.length){ skipped.push({ name, size: type.size, reason: '空结构体 / 没有可采样成员' }); return; }
        for (const m of type.members){
          const child = `${name}.${m.name}`;
          if (m.reason){ skipped.push({ name: child, size: m.type?.size, reason: m.reason }); continue; }
          leaves(child, (addr + m.offset) >>> 0, m.type, group, depth + 1);
        }
        return;
      }
      if (type.kind === 'scalar'){
        if (!type.scalar){ skipped.push({ name, size: type.size, reason: type.reason || '类型不在采样表里' }); return; }
        if (!inRam(addr)){ skipped.push({ name, size: type.size, reason: `地址 ${hex32(addr)} 不在 RAM 窗口（可写数据区） ${winTxt()}` }); return; }
        sampleable.push({ name, label: name, addr, size: type.size, scalar: type.scalar,
                          typeName: type.name || type.scalar, group: group || name, path: name });
        return;
      }
      skipped.push({ name, size: type.size, reason: type.reason || `不支持的类型（${type.kind}）` });
    };

    for (const rec0 of this._arr){
      if (rec0.tag !== TAG.variable) continue;
      this.stats.vars++;
      const rec = this.merged(rec0);                    // 名字/类型可能在"声明"那一头
      const nm = this.name(rec);
      if (!nm){ skipped.push({ name: `(无名变量 @${rec0.offset})`, reason: 'DWARF 里没有名字（也追不到声明）' }); continue; }
      if (rec.attrs.get(AT.declaration)) continue;                    // 只是声明
      const fa = this.fixedAddr(rec);
      if (fa.addr == null){ skipped.push({ name: nm, reason: fa.reason }); continue; }
      leaves(nm, fa.addr, this.type(this.num(rec, AT.type)), nm, 0);
    }
    sampleable.sort((a, b) => a.addr - b.addr || a.name.localeCompare(b.name));
    return { sampleable, skipped, arrays, stats: { ...this.stats } };
  }
}

function upperBound(arr, offset){
  let lo = 0, hi = arr.length;
  while (lo < hi){ const mid = (lo + hi) >> 1; if (arr[mid].offset <= offset) lo = mid + 1; else hi = mid; }
  return lo;
}

/**
 * 从 ELF 自己的节表推"哪些地址是 RAM"：`SHF_ALLOC | SHF_WRITE` 的可写节
 * （`.data` / `.bss` / `.noncacheable` …）覆盖的区间。
 *
 * 🚨 为什么不能只用 STM32 那套默认窗口（2026-10 真机验收踩到）：
 *    `DEFAULT_RAM = [0x20000000, 0x40000000)` 对 STM32 成立，但 RISC-V 的 HPM 系列
 *    RAM 在 `0x00000000`(ILM) / `0x01200000`(SRAM) —— 用默认窗口过滤会把**全部**变量
 *    判成"不在 RAM 窗口"，界面显示"可采样 0 个"，看着像页面坏了。
 *    改成问 ELF 自己：可写节的地址区间就是 RAM。找不到可写节时才退回默认窗口。
 */
export function ramWindowsOf(elf){
  const out = [];
  try {
    for (const s of elf.sections()){
      if (s.type === 8 /* SHT_NOBITS */ || s.type === 1 /* PROGBITS */){
        const ALLOC = 0x2, WRITE = 0x1;
        if ((s.flags & ALLOC) && (s.flags & WRITE) && s.size) out.push([s.addr >>> 0, (s.addr + s.size) >>> 0]);
      }
    }
  } catch { /* 节表坏了就当没有 */ }
  /**
   * ⚠️ **并上默认窗口**，而不是"有可写节就不看默认窗口"：
   *    有些快照/裁剪过的 ELF 只有很小一段可写节覆盖不到全部变量，
   *    只信可写节会把本来能采样的变量判掉（dwarf 自测就是这么炸的）。
   *    并集的最坏后果是"多认了几个地址"（RISC-V 镜像里 0x2xxxxxxx 基本是 ROM，不会有全局变量），
   *    比"漏掉真变量"轻得多。
   */
  out.push([DEFAULT_RAM[0], DEFAULT_RAM[1]]);
  if (!out.length) return [DEFAULT_RAM];
  // 合并相邻/重叠区间（`.data`/`.bss`/`.noncacheable` 常连着）
  out.sort((a, b) => a[0] - b[0]);
  const merged = [out[0].slice()];
  for (const [a, b] of out.slice(1)){
    const last = merged[merged.length - 1];
    if (a <= last[1] + 0x1000) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged;
}

/**
 * 一步到位：给一个 ELF，拿到"能采样的通道 + 采不了的原因"。
 * 没有 DWARF 时**退化**到符号表（有地址有大小，但没有类型 —— 界面必须让用户手选类型）。
 *
 * 版本支持：**DWARF 4 与 5**（GCC 11+ 默认就是 5，HPM SDK 也是）。
 * v5 的关键增量：CU 头多了 unit_type、`strx*`/`addrx*` 两族间接表单（要查 .debug_str_offsets /
 * .debug_addr，基址来自 `DW_AT_str_offsets_base`/`DW_AT_addr_base`，缺省 8）、`line_strp`、
 * 位置表达式里的 `DW_OP_addrx`。这些都在 `_value()` / `fixedAddr()` 里实现。
 *
 * 🚨 真解析不了时（遇到没实现的 form / 文件坏了）**不能整盘失败**：
 *    退回符号表并把原因写进 `note`（`listSampleable` 的调用方负责显示）。
 *    否则用户看到的是"解析失败 + 一个变量都没有"，像页面坏了。
 */
export function listSampleable(elf, opts = {}){
  const ram = opts.ram || ramWindowsOf(elf);
  if (Dwarf.available(elf)){
    let note = '';
    try {
      const dw = opts.dwarf || new Dwarf(elf);          // 调用方已经建过就复用（解析一次很贵）
      const versions = [...new Set(dw.versions())];
      const r = dw.listVariables({ ...opts, ram });
      return { ...r, source: 'dwarf', versions, note, ram, dwarf: dw };
    } catch (e){
      note = `DWARF 解析失败（${e?.message || e}）：已退回符号表（类型要手选）`;
    }
    const r = listFromSymtab(elf, { ...opts, ram });
    return { ...r, note, ram };
  }
  return { ...listFromSymtab(elf, { ...opts, ram }), ram };
}

/** 没有 DWARF 时的退化路径：符号表（有地址有大小、**没有类型** → 界面必须让用户手选类型）*/
export function listFromSymtab(elf, opts = {}){
  const wins = Array.isArray(opts.ram?.[0]) ? opts.ram : [opts.ram || DEFAULT_RAM];
  const inRam = a => wins.some(([lo, hi]) => a >= lo && a < hi);
  const sampleable = [], skipped = [];
  for (const s of elf.symbols()){
    if (!s.isObject || !s.name) continue;
    if (!s.size){ skipped.push({ name: s.name, reason: '符号大小为 0（类型/数组长度未知）' }); continue; }
    if (!inRam(s.addr)){ skipped.push({ name: s.name, size: s.size, reason: `地址 ${hex32(s.addr)} 不在 RAM 窗口（可写数据区）` }); continue; }
    sampleable.push({ name: s.name, label: s.name, addr: s.addr, size: s.size, scalar: null,
                      typeName: '未知（请手选类型）', group: s.name, path: s.name });
  }
  return { sampleable, skipped, stats: { vars: sampleable.length + skipped.length },
           source: 'symtab', versions: [] };
}

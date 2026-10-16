/**
 * 命令行的 Tab 补全（纯逻辑）—— 「xshell 那种手感」里最实用的一条。
 *
 * 规则跟 shell/gdb 一致，别自作聪明：
 *   · 行首（还没敲空格）补 **命令名**；
 *   · 参数位按命令补**符号名 / 寄存器名 / 断点号 / 源码文件名**；
 *   · 唯一候选 → 直接补上（命令名后面还带一个空格，省得再敲）；
 *   · 多个候选 → 补**公共前缀**，补不动就把候选列出来（界面负责打印）；
 *   · 一个都没有 → 什么都不做（绝不"猜一个最近的"）。
 *
 * 这个文件只依赖传进来的几份清单（符号表 / 寄存器名 / 断点 / 源文件），
 * 所以能在 Node 里测到底，不用浏览器也不用硬件。
 */

import { imageWords } from './image.js';

export const CMD_NAMES = [
  'h', 'help', 'c', 'cont', 's', 'step', 'n', 'next', 'si', 'fin', 'out', 'rc',
  'halt', 'reset', 'r', 'md', 'mw', 'ms', 'fill_ram', 'fill_inc', 'load_image', 'dump_image',
  'p', 'x', 'b', 'bd', 'bl', 'wp', 'wpl', 'wpd', 'bt', 'backtrace', 'frame', 'locals', 'args', 'info', 'sym', 'w', 'wl', 'wd', 'src', 'sl', 'cls',
];

const SYM_CMDS = new Set(['wp', 'b', 'break', 'p', 'x', 'w', 'watch', 'md', 'mw', 'ms', 'sym', 'rc', 'runto']);
const REG_CMDS = new Set(['r', 'reg', 'regs']);

/** 最长公共前缀 */
export function commonPrefix(list){
  if (!list.length) return '';
  let p = list[0];
  for (const s of list){
    let i = 0;
    while (i < p.length && i < s.length && p[i] === s[i]) i++;
    p = p.slice(0, i);
    if (!p) break;
  }
  return p;
}

/** 把 `line` 里最后一个词（光标前）换掉 */
function replaceLastToken(line, token, next){
  const head = line.slice(0, line.length - token.length);
  return head + next;
}

/**
 * @param {string} line 当前输入框内容（补全按"整行末尾"算，界面里的光标默认就在末尾）
 * @param {object} ctx `{sym, regs, bps, files, watch, limit}`
 * @returns {{value:string, candidates:string[], total:number, kind:string, prefix:string}}
 */
export function completeLine(line, ctx = {}){
  const src = String(line ?? '');
  const limit = ctx.limit || 60;
  const m = /(\S*)$/.exec(src);
  const token = m ? m[1] : '';
  const head = src.slice(0, src.length - token.length);
  const isCmdPos = !/\S/.test(head);                 // 前面只有空白 = 在敲命令名
  let parts = head.trim() ? head.trim().split(/\s+/) : [];
  const cmd = (parts[0] || '').toLowerCase();
  if (cmd === 'load_image' || cmd === 'dump_image'){
    try { parts = imageWords(head.trim()); }
    catch { parts = [cmd]; } // An unfinished quoted filename has no format candidates yet.
  }
  const argIndex = parts.length;                     // 0 = 第一个参数

  let pool = [], kind = 'none';
  if (isCmdPos){
    pool = CMD_NAMES;
    kind = 'cmd';
  } else if (REG_CMDS.has(cmd)){
    pool = ctx.regs || [];
    kind = 'reg';
  } else if (SYM_CMDS.has(cmd) && argIndex <= 1){
    pool = symbolNames(ctx.sym);
    kind = 'symbol';
  } else if (cmd === 'wp' && argIndex === 2){
    pool = ['r','w','rw']; kind = 'word';
  } else if (cmd === 'wp' && argIndex === 3){
    pool = ['1','2','4','8','16','32','64']; kind = 'word';
  } else if (cmd === 'wpd'){
    pool = [...(ctx.wps || []).map(w=>'#'+(w.slot+1)), 'all']; kind = 'wp';
  } else if ((cmd === 'bt' || cmd === 'backtrace') && argIndex === 1){
    pool = ['scan','8','16','32','64']; kind = 'word';
  } else if (cmd === 'info' && argIndex === 1){
    pool = ['locals','args'];kind = 'word';
  } else if (cmd === 'bd' || cmd === 'delete'){
    pool = [...(ctx.bps || []).map((b, i) => `#${i + 1}`), 'all'];
    kind = 'bp';
  } else if (cmd === 'reset'){
    pool = ['run', 'halt'];
    kind = 'word';
  } else if (cmd === 'load_image' && argIndex === 3){
    pool = ['bin', 'ihex', 'elf', 's19'];
    kind = 'word';
  } else if (cmd === 'src'){
    pool = ctx.files || [];
    kind = 'file';
  } else if ((cmd === 'wd' || cmd === 'watch-del') && argIndex <= 1){
    pool = (ctx.watch || []).map(it => it.expr);
    kind = 'watch';
  }

  let hits = pool.filter(s => s.startsWith(token));
  if (!hits.length && token) hits = pool.filter(s => s.toLowerCase().startsWith(token.toLowerCase()));
  const total = hits.length;
  const shown = hits.slice(0, limit);

  // 唯一候选：命令名补完再给个空格（shell 的习惯），参数补完不给空格
  if (total === 1){
    const only = shown[0];
    const next = isCmdPos ? only + ' ' : only;
    return { value: replaceLastToken(src, token, next), candidates: [only], total, kind, prefix: only };
  }
  if (total > 1){
    const p = commonPrefix(shown);
    const value = p.length > token.length ? replaceLastToken(src, token, p) : src;
    return { value, candidates: shown, total, kind, prefix: p };
  }
  return { value: src, candidates: [], total: 0, kind, prefix: token };
}

/** 符号名清单：带类型的变量排前面（`p`/`w` 最常用），再函数，再数据对象 */
export function symbolNames(sym){
  if (!sym) return [];
  const seen = new Set(), out = [];
  const push = (n) => { if (n && !seen.has(n)){ seen.add(n); out.push(n); } };
  for (const v of sym.vars) push(v.name);
  for (const f of sym.funcs) push(f.name);
  for (const o of sym.objs) push(o.name);
  return out;
}

/** Read-only, bounded fault snapshots. Call while holding DebugSession.exclusive(). */
import { backtrace } from './backtrace.js';
import { finding as f, metric as m } from '../diagnostics/report.js';
export const hex = v => v == null ? '未知' : '0x' + (v >>> 0).toString(16).padStart(8, '0');
const SCB = { CPUID: 0xe000ed00, ICSR: 0xe000ed04, VTOR: 0xe000ed08, SHCSR: 0xe000ed24,
  CFSR: 0xe000ed28, HFSR: 0xe000ed2c, DFSR: 0xe000ed30, MMFAR: 0xe000ed34, BFAR: 0xe000ed38, AFSR: 0xe000ed3c };
const RETURN = new Set([0xfffffff1, 0xfffffff9, 0xfffffffd, 0xffffffe1, 0xffffffe9, 0xffffffed]);
const flags = [
  [0,'IACCVIOL：指令访问违反 MPU 保护'], [1,'DACCVIOL：数据访问违反 MPU 保护'], [3,'MUNSTKERR：异常出栈时访问失败'],
  [4,'MSTKERR：异常入栈时访问失败'], [5,'MLSPERR：浮点延迟保存时访问失败'],
  [8,'IBUSERR：取指总线错误'], [9,'PRECISERR：精确数据总线错误'], [10,'IMPRECISERR：非精确数据总线错误'],
  [11,'UNSTKERR：异常出栈时总线错误'], [12,'STKERR：异常入栈时总线错误'], [13,'LSPERR：浮点延迟保存时总线错误'],
  [16,'UNDEFINSTR：未定义指令'], [17,'INVSTATE：执行状态无效'], [18,'INVPC：异常返回值无效'],
  [19,'NOCP：协处理器未启用／不可用'], [24,'UNALIGNED：未对齐访问'], [25,'DIVBYZERO：除零']
];
const STACK_BAD = (1<<3)|(1<<4)|(1<<5)|(1<<11)|(1<<12)|(1<<13);
const causeNames = {0:'指令地址未对齐',1:'指令访问错误',2:'非法指令',3:'断点异常',4:'读取地址未对齐',5:'读取访问错误',6:'写入地址未对齐',7:'写入访问错误',8:'U 模式环境调用',9:'S 模式环境调用',11:'M 模式环境调用',12:'指令页错误',13:'读取页错误',15:'写入页错误'};
const interrupts = {1:'S 软件中断',3:'M 软件中断',5:'S 定时器中断',7:'M 定时器中断',9:'S 外部中断',11:'M 外部中断'};
const validRam = (s, a, n) => Number.isInteger(a) && a%4===0 && a+n<=0x100000000 &&
  ((a>=0x20000000 && a+n<=0x40000000) || (a>=0x60000000 && a+n<=0xa0000000) ||
    s.sym?.elf?.sections?.().some(sec=>(sec.flags&1) && !(sec.flags&4) && a>=sec.addr && a+n<=sec.addr+sec.size));
const executable = (s, pc) => s.sym?.elf?.sections?.().some(sec=>(sec.flags&4) && pc>=sec.addr && pc<sec.addr+sec.size);

export function decodeArm(raw){
  const findings = [], c = raw.CFSR ?? 0, h = raw.HFSR ?? 0;
  if (![0xc23,0xc24,0xc27].includes((raw.CPUID>>>4)&0xfff)) return [f('证据不足', '当前内核不属于已支持的 Cortex-M3/M4/M7；未套用其故障寄存器语义。')];
  for (const [bit,name] of flags) if(c & (1<<bit)) findings.push(f('已确认', name, `CFSR bit ${bit}`));
  if(h & (1<<30)) findings.push(f('已确认', 'FORCED：可配置异常升级为 HardFault。', 'HFSR bit 30'));
  if(h & 2) findings.push(f('已确认', 'VECTTBL：读取异常向量表时总线出错。', 'HFSR bit 1'));
  if(h & 0x80000000) findings.push(f('已确认', 'DEBUGEVT：调试事件引发 HardFault。', 'HFSR bit 31'));
  if(c & 128) findings.push(f('已确认', `有效 MMFAR：${hex(raw.MMFAR)}`, 'MMARVALID 已置位'));
  if(c & 0x8000) findings.push(f('已确认', `有效 BFAR：${hex(raw.BFAR)}`, 'BFARVALID 已置位'));
  if(c & (1<<10)) findings.push(f('证据不足', '非精确总线错误的保存 PC 可能晚于致错指令，不能当成准确故障位置。'));
  if(c & STACK_BAD) findings.push(f('证据不足', '异常入栈／出栈或浮点保存出错，停止恢复硬件异常帧。'));
  if(!c && !h) findings.push(f('证据不足', '未发现 CFSR/HFSR 故障标志；可能是普通断点、标志已被固件清除或其它异常。'));
  findings.push(f('证据不足', '故障标志具有粘性，可能来自更早的异常；本次读取没有清除它们。'));
  return findings;
}

export function decodeRiscv(raw){
  const value = raw.mcause >>> 0, interrupt = !!(value & 0x80000000), code = value & 0x7fffffff;
  const findings = [f('已确认', `${interrupt ? '中断' : '异常'}代码 ${code}：${(interrupt ? interrupts : causeNames)[code] || '平台自定义／未识别'}`, `mcause=${hex(value)}`),
    f('证据不足', '机器级 trap CSR 保留最近一次陷入信息；不能证明当前停点就是该次 trap，也不覆盖 S 模式 trap。')];
  if (interrupt) findings.push(f('已确认', 'mcause 的中断标志已置位，定时器等正常中断不应直接判成故障。'));
  else if ([0,1,4,5,6,7,12,13,15].includes(code)) findings.push(f('证据不足', `mtval=${hex(raw.mtval)} 是地址信息候选，是否提供有效地址取决于实现；零值不能证明地址为零。`));
  else if(code===2) findings.push(f('证据不足', '非法指令的 mtval 可能保存指令位，也可能为零，不按访问地址解释。'));
  findings.push(f('证据不足', '通用 CSR 不含完整 trap 保存栈；未配置固件 trap 帧布局时，无法恢复异常前完整调用栈。'));
  return findings;
}

export async function captureFault(s){
  const result = { arch: s.arch.name, at: new Date().toISOString(), pc: null, raw: {}, frame: null, frames: [], findings: [], error: null };
  if(!s.connected || !s.halted){ result.error='先连接并手动暂停目标；诊断不自动改变运行状态'; return result; }
  let reads = 0, failed = false; const deadline = Date.now()+10000;
  const guard = async fn => {
    if(failed || ++reads>80 || Date.now()>deadline) throw new Error('诊断读取达到边界，停止后续访问');
    try { return await fn(); } catch(e){ failed=true; throw e; }
  };
  try {
    if(s.arch.name==='riscv'){
      // readReg() would call _ensureHalted(), which may halt a running hart. Bypass it deliberately.
      result.observedHalted=await guard(()=>s._pollHalted());
      if(!result.observedHalted) throw new Error('目标已运行；未暂停 hart');
      for(const [name,num] of Object.entries({pc:0x7b1,mcause:0x342,mepc:0x341,mtval:0x343,mstatus:0x300,mtvec:0x305,dcsr:0x7b0}))
        result.raw[name] = (await guard(()=>s.dm.readReg(num)))>>>0;
      result.pc=result.raw.pc;
      result.findings=decodeRiscv(result.raw);
      if(!await guard(()=>s._pollHalted()) || (await guard(()=>s.dm.readReg(0x7b1)))>>>0 !== result.pc) throw new Error('读取期间目标状态改变，现场已过期');
    } else {
      const read = (a,n)=>guard(()=>s.probe.readMemDiagnostic(a,n));
      const word = async a=>{const b=await read(a,4); if(b.length!==4)throw new Error('诊断内存短读'); return new DataView(b.buffer,b.byteOffset,4).getUint32(0,true);};
      result.observedHalted=!!((await word(0xe000edf0)) & (1<<17));
      if(!result.observedHalted) throw new Error('目标已运行；未暂停内核');
      result.raw.CPUID=await word(SCB.CPUID);
      if(![0xc23,0xc24,0xc27].includes((result.raw.CPUID>>>4)&0xfff)){ result.findings=decodeArm(result.raw); return result; }
      // Capture fault registers before any stack read might fail. Address validity is decoded separately.
      for(const [name,a] of Object.entries(SCB)) if(name!=='CPUID')result.raw[name]=await word(a);
      if(((result.raw.CPUID>>>4)&0xfff)===0xc27) result.raw.ABFSR=await word(0xe000efa8);
      const regs={};
      for(const [name,sel] of Object.entries({PC:15,LR:14,XPSR:16,SP:13,MSP:17,PSP:18})) regs[name]=(await guard(()=>s.probe.regReadDiagnostic(sel)))>>>0;
      result.pc=regs.PC; result.raw.core=regs; result.findings=decodeArm(result.raw);
      const ipsr=regs.XPSR & 511;
      if(![3,4,5,6].includes(ipsr)) result.findings.push(f('证据不足', `当前 IPSR=${ipsr}，未停在 HardFault/MemManage/BusFault/UsageFault；不从当前 SP 恢复异常前栈。`));
      else if(!(result.raw.CFSR & STACK_BAD)){
        let candidate=null;
        if(RETURN.has(regs.LR) && ((regs.LR&16) || ((result.raw.CPUID>>>4)&0xfff)!==0xc23)){
          const base=(regs.LR&4)?regs.PSP:regs.MSP, offset=(regs.LR&16)?0:72;
          if(!validRam(s,base,offset+32)) result.findings.push(f('证据不足', '异常栈地址未通过 RAM 范围／对齐验证，未读取。'));
          else {
            const b=await read(base+offset,32); if(b.length!==32)throw new Error('异常帧短读');
            const v=Array.from({length:8},(_,i)=>new DataView(b.buffer,b.byteOffset,32).getUint32(i*4,true));
            const thread=!!(regs.LR&8), stackedIpsr=v[7]&511;
            if((v[7]&0x01000000) && validRam(s,base,offset+32+((v[7]&512)?4:0)) && (v[6]&1)===0 && v[6]!==0 && ((thread&&stackedIpsr===0)||(!thread&&stackedIpsr!==0)) && (!s.sym || executable(s,v[6]))){
              const r=new Array(16).fill(0); for(let i=0;i<4;i++)r[i]=v[i];r[12]=v[4];r[14]=v[5];r[15]=v[6];r[13]=base+offset+32+((v[7]&512)?4:0);
              const vector=result.raw.VTOR+ipsr*4;
              const vectorValid=result.raw.VTOR%128===0 && vector+4<=0xa0000000 && !(vector>=0x40000000 && vector<0x60000000);
              const handler=vectorValid ? await word(vector) : 0;
              candidate={pc:r[15],sp:r[13],regs:r,known:[0,1,2,3,12,13,14,15],kind:'exception',loc:s.sym?.at?.(r[15])||null,name:s.sym?.funcAt?.(r[15])?.name||''};
              result.frame={...candidate,base,stack:(regs.LR&4)?'PSP':'MSP',extended:!((regs.LR&16)),aligned:!!(v[7]&512),xpsr:v[7],validated:((handler&0xfffffffe)>>>0)===regs.PC};
              if(!result.frame.validated)result.findings.push(f('证据不足', '找到结构校验通过的异常帧候选；当前 PC 已离开向量入口，SP 可能受函数序言影响，需用展开信息验证。'));
            } else result.findings.push(f('证据不足', 'SP 处的数据未通过硬件帧 xPSR／返回模式／PC 校验，未作为异常前现场。'));
          }
        }
        // Reuse bounded CFI/EHABI to unwind the handler (including its saved EXC_RETURN).
        // This adapter never refreshes/halt/resets, and never heals a failed debug port.
        const cache={...regs};
        const safeSession={arch:s.arch,sym:s.sym,halted:true,refresh:async()=>{},
          readReg:async name=>{const key=String(name).toUpperCase(); if(cache[key]!=null)return cache[key];
            const sel=/^R(?:[0-9]|1[0-2])$/.test(key)?Number(key.slice(1)):null;
            if(sel==null)throw new Error('异常展开所需寄存器不可用');
            return cache[key]=(await guard(()=>s.probe.regReadDiagnostic(sel)))>>>0;},
          memRead:async(a,n)=>{if(!validRam(s,a,n))throw new Error('展开超出允许 RAM 范围');return read(a,n);}};
        if(s.sym){
          const trace=await backtrace(safeSession,{depth:8,stackBytes:512});
          result.handlerFrames=trace.frames; result.unwindReason=trace.reason;
          const restored=trace.frames.find(frame=>frame.kind==='exception');
          if(restored){candidate=restored; result.frame={...restored,...restored.exception,validated:true,unwound:true};}
        }
        if(candidate && result.frame.validated){
          result.frames=[candidate];
          result.findings.push(f('已确认', `恢复异常硬件帧，保存 PC=${hex(candidate.pc)}。`, '保存 PC 是被打断的执行位置；非精确错误不能据此定位致错指令'));
          if(s.sym && !failed){
            const trace=await backtrace(safeSession,{depth:8,stackBytes:512,initial:{regs:candidate.regs,known:candidate.known}});
            result.frames=trace.frames; result.unwindReason=trace.reason;
          }
        } else if(!candidate)result.findings.push(f('证据不足', '当前 LR 不是可直接恢复的 EXC_RETURN 或无法验证保存帧；需匹配的 ELF 展开信息或在异常入口停住。'));
      }
      if(failed)throw new Error('栈展开读取失败，后续诊断访问已停止');
      if(!((await word(0xe000edf0)) & (1<<17)) || (await guard(()=>s.probe.regReadDiagnostic(15)))>>>0 !== result.pc) throw new Error('读取期间目标状态改变，现场已过期');
    }
  }catch(e){ result.error=e.message || String(e); result.findings.push(f('证据不足', '现场读取不完整，已停止后续诊断访问。', result.error)); }
  result.reads=reads;
  return result;
}

export function faultData(snapshot, historical=false){
  const raw=snapshot.raw, rv=snapshot.arch==='riscv';
  const metrics=Object.entries(raw).filter(([,v])=>typeof v==='number').map(([k,v])=>m(k,hex(v),'','目标寄存器',
    k==='BFAR' && !(raw.CFSR&0x8000) ? 'BFARVALID 未置位，不能作为故障地址' : k==='MMFAR' && !(raw.CFSR&128) ? 'MMARVALID 未置位，不能作为故障地址' : ''));
  if(snapshot.pc!=null)metrics.unshift(m('停止 PC',hex(snapshot.pc),'','目标寄存器'));
  if(raw.core)for(const [name,value] of Object.entries(raw.core))if(name!=='PC')metrics.push(m(name,hex(value),'','当前内核寄存器',name==='XPSR'?`IPSR=${value&511}`:''));
  if(snapshot.frame) metrics.push(m(snapshot.frame.validated?'异常保存 PC':'异常帧候选 PC',hex(snapshot.frame.pc),'','硬件保存帧', snapshot.frame.validated?'已校验；非精确错误不保证为致错指令':'尚未验证，不作为准确故障位置'));
  return { settings:{架构:snapshot.arch, 现场时间:snapshot.at, 时段:historical?'历史现场（目标状态或 ELF 已变更）':snapshot.error?'未验证现场（读取不完整）':'当前停止现场',
      ...(snapshot.frame ? { 恢复栈:snapshot.frame.stack, 帧类型:snapshot.frame.extended?'浮点扩展帧':'基本帧', 帧校验:snapshot.frame.validated?'已验证':'候选，尚未验证' } : {}),
      完整性:snapshot.error ? '读取不完整' : '已完成有限读取', 本页启用HardFault捕获:!!snapshot.catchConfigured, 展开停止原因:snapshot.unwindReason || '没有可验证的异常前调用链'},
    metrics, findings:snapshot.findings, snapshot,
    notes: [rv?'RV32 机器级 trap CSR 不能替代固件保存的 trap frame。':'支持 Cortex-M3/M4/M7；无效 BFAR/MMFAR、堆栈失败与非精确错误均不输出虚假的准确位置。',
      '只读诊断不主动暂停、继续、复位目标或清除异常寄存器。读取失败立即停止，保留已取得的证据。',
      'ELF 必须与板上固件一致。完整调用链取决于有效栈与 CFI/EHABI 展开信息，未保存的 r4–r11 不会从处理器当前值伪造。'] };
}

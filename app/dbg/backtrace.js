/** Read-only, bounded ARM EHABI unwinding. Never execute personality code on target.
 * ABI: https://github.com/ARM-software/abi-aa/blob/main/ehabi32/ehabi32.rst
 */
export const prel31=(word,place)=>(place+((word<<1)>>1))>>>0;
const word=b=>new DataView(b.buffer,b.byteOffset,b.byteLength).getUint32(0,true);
const even=a=>(a&0xfffffffe)>>>0;
const exceptionReturn=a=>[0xfffffff1,0xfffffff9,0xfffffffd,0xffffffe1,0xffffffe9,0xffffffed].includes(a>>>0);
const bytesOf=w=>[w>>>24,(w>>>16)&255,(w>>>8)&255,w&255];
export function exidxEntry(elf,pc){
  const sec=elf?.section('.ARM.exidx'), bytes=elf?.data('.ARM.exidx');
  if(!sec || !bytes?.length) throw new Error('ELF 缺少 .ARM.exidx 展开表；可用 bt scan 查看候选返回地址');
  if(bytes.length%8) throw new Error('.ARM.exidx 长度无效');
  const dv=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  let entry=null, previous=-1;
  for(let i=0;i<bytes.length;i+=8){
    const start=even(prel31(dv.getUint32(i,true),sec.addr+i));
    if(start<previous) throw new Error('.ARM.exidx 函数地址非单调');
    previous=start;
    if(start>pc) break;
    entry={start,value:dv.getUint32(i+4,true),place:sec.addr+i+4};
  }
  if(!entry) throw new Error('当前 PC 无对应展开表项');
  return entry;
}
export function unwindBytes(elf,entry){
  if(entry.value===1) throw new Error('EXIDX_CANTUNWIND：此函数不能展开');
  const inline=!!(entry.value&0x80000000), addr=prel31(entry.value,entry.place);
  let first=entry.value;
  if(!inline){ const b=elf.bytesAt(addr,4,{ro:true}); if(!b || b.length<4) throw new Error('.ARM.extab 地址无效'); first=word(b); }
  const personality=first>>>24;
  if(personality===0x80) return bytesOf(first).slice(1);
  if(personality!==0x81 && personality!==0x82) throw new Error('不支持该展开 personality（不会执行目标代码）');
  const extra=(first>>>16)&255;
  if(extra>64 || (inline&&extra)) throw new Error('展开表过长或 inline 格式无效');
  const out=bytesOf(first).slice(2);
  for(let i=0;i<extra;i++){
    const b=elf.bytesAt(addr+4+i*4,4,{ro:true}); if(!b || b.length<4) throw new Error('展开表被截断');
    out.push(...bytesOf(word(b)));
  }
  return out;
}
/** Core integer and VFP stack adjustments; unsupported/reserved opcodes fail closed. */
export async function unwindFrame(input,ops,readWord,validSp,context=null){
  const r=Uint32Array.from(input); r[15]=0;
  const available=new Set(context?[...context.input].filter(n=>n>=4&&n<=11):[]);
  let cursor=0, pcWritten=false;
  const next=()=>{ if(cursor>=ops.length) throw new Error('展开指令被截断'); return ops[cursor++]; };
  const move=delta=>{ const v=r[13]+delta; if(!validSp(v,0)) throw new Error('展开 SP 超出读取边界'); r[13]=v; };
  const pop=async regs=>{
    let sp=r[13], loadedSp=null;
    for(const n of regs){
      if(!validSp(sp,4)) throw new Error('栈读取超出边界');
      const v=await readWord(sp); available.add(n);if(n===13) loadedSp=v; else { r[n]=v; if(n===15) pcWritten=true; } sp+=4;
    }
    r[13]=loadedSp??sp;
    if(!validSp(r[13],0)) throw new Error('弹出的 SP 不合法');
  };
  while(cursor<ops.length){
    const op=next();
    if(op<=0x3f) move((op&63)*4+4);
    else if(op<=0x7f) move(-((op&63)*4+4));
    else if(op<=0x8f){
      const mask=((op&15)<<8)|next(); if(!mask) throw new Error('展开指令拒绝回溯');
      await pop(Array.from({length:12},(_,i)=>i+4).filter(n=>mask&(1<<(n-4))));
    } else if(op<=0x9f){
      const n=op&15; if(n===13||n===15||(context&&!context.input.has(n)&&!available.has(n))||!validSp(r[n],0)) throw new Error('展开 vsp 寄存器无效'); r[13]=r[n];
    } else if(op<=0xaf){
      const regs=Array.from({length:(op&7)+1},(_,i)=>i+4); if(op&8) regs.push(14); await pop(regs);
    } else if(op===0xb0){ break; }
    else if(op===0xb1){ const m=next(); if(!m||(m&0xf0)) throw new Error('非法低寄存器 mask'); await pop([0,1,2,3].filter(n=>m&(1<<n))); }
    else if(op===0xb2){
      let value=0, shift=0, b;
      do { b=next(); value+=(b&127)*2**shift; shift+=7; if(shift>28) throw new Error('展开 ULEB128 过长'); } while(b&128);
      move(0x204+value*4);
    } else if(op===0xb3){ const b=next(); if((b>>>4)+(b&15)>15) throw new Error('VFP 范围无效'); move(((b&15)+1)*8+4); }
    else if(op>=0xb8&&op<=0xbf) move(((op&7)+1)*8+4);
    else if(op===0xc8||op===0xc9){ const b=next(); if((op===0xc8?16:0)+(b>>>4)+(b&15)>31) throw new Error('VFP 范围无效'); move(((b&15)+1)*8); }
    else if(op>=0xd0&&op<=0xd7) move(((op&7)+1)*8);
    else throw new Error('不支持展开 opcode 0x'+op.toString(16));
  }
  // EHABI implies Finish when the instruction byte stream is exhausted.
  if(!pcWritten){if(context&&!available.has(14)&&!context.input.has(14))throw new Error('LR 不可恢复');r[15]=r[14];}
  available.add(13);available.add(15);if(context)context.output=available;
  return r;
}
function decorate(s,pc,sp,kind,returned=false){
  const address=even(pc), rewind=s.arch.name==='riscv'?1:2;
  const lookup=returned&&address>=rewind?address-rewind:address;
  return {pc:address,sp:sp>>>0,kind,lookup,name:s.sym?.nameOf?.(lookup)||'',loc:s.sym?.at?.(lookup)||null};
}
function executable(elf,pc){ return elf?.sections().some(sec=>(sec.flags&4)&&pc>=sec.addr&&pc<sec.addr+sec.size); }
export async function backtrace(s,{depth=16,scan=false,stackBytes=4096,signal,initial}={}){
  if(!Number.isInteger(depth)||depth<1||depth>64) throw new Error('bt 深度须为 1..64');
  if(!Number.isInteger(stackBytes)||stackBytes<32||stackBytes>65536||stackBytes%4) throw new Error('栈读取范围须为 32..65536 字节且按4字节对齐');
  const cancel=()=>{if(signal?.()){const e=new Error('栈回溯已中断'); e.cancelled=true; throw e;}};
  if(initial && (s.arch.name!=='arm' || scan || initial.regs?.length!==16 || ![13,14,15].every(i=>initial.known?.includes(i))))throw new Error('异常恢复寄存器集无效');
  if(!initial)await s.refresh(); if(!s.halted) throw new Error('先暂停目标再回溯（不自动停止正在运行的程序）');
  const sp=initial?initial.regs[13]:await s.readReg(s.arch.SP), pc=initial?initial.regs[15]:await s.readReg(s.arch.PC);
  if(sp%4 || sp+stackBytes>0x100000000) throw new Error('SP 未对齐或读取范围跨 u32 边界');
  const frames=[decorate(s,pc,sp,'current')], elf=s.sym?.elf;
  let reason='达到回溯深度上限';
  const readWord=async a=>{cancel(); const b=await s.memRead(a,4); if(b.length!==4) throw new Error('栈短读'); return word(b);};
  const valid=(a,n)=>Number.isInteger(a)&&a%4===0&&a>=sp&&a+n<=sp+stackBytes;
  if(depth===1&&scan) return {frames,reason,scan};
  if(scan){
    if(!elf) return {frames,reason:'扫描需要 ELF 代码和符号验证候选地址',scan:true};
    reason='扫描结果仅为候选返回地址，可能含旧栈值或普通数据，不是已证实调用链';
    const candidate=async(value,slot)=>{
      cancel(); if(frames.length>=depth) return;
      const a=even(value);
      const rewind=s.arch.name==='riscv'?1:2;
      if((s.arch.name==='arm'&&!(value&1))||!executable(elf,a-rewind)) return;
      const target=await s.arch.callEndingAt(async(a,n)=>elf.bytesAt(a,n,{ro:true}),value);
      if(target!=null) frames.push({...decorate(s,value,slot??sp,'candidate',true),slot});
    };
    try {
      await candidate(await s.readReg(s.arch.LR),null);
      const limit=Math.min(stackBytes,4096);
      for(let offset=0;offset<limit&&frames.length<depth;offset+=128){
        cancel(); const length=Math.min(128,limit-offset);
        let bytes;
        try { bytes=await s.memRead(sp+offset,length); }
        catch(e){
          // A halted stack is often close to RAM's upper boundary. Salvage the
          // readable prefix instead of discarding LR/all frames after a bulk FAULT.
          for(let k=0;k<length&&frames.length<depth;k+=4){
            let value;
            try { value=await readWord(sp+offset+k); }
            catch(inner){ if(inner.cancelled) throw inner; reason+='；扫描到读取边界：'+inner.message; break; }
            await candidate(value,sp+offset+k);
          }
          break;
        }
        for(let k=0;k+4<=bytes.length;k+=4) await candidate(word(bytes.subarray(k,k+4)),sp+offset+k);
        if(bytes.length!==length){reason+='；扫描短读';break;}
      }
    } catch(e){if(e.cancelled) throw e; reason+='；扫描停止：'+e.message;}
    return {frames,reason,scan:true};
  }
  if(!elf) return {frames,reason:'请载入与目标固件一致的 ELF（需要 .debug_frame 或 .ARM.exidx）',scan:false};
  const {cfiRow,unwindCfi}=await import('./cfi.js');
  const riscv=s.arch.name==='riscv',registerCount=riscv?33:16,pcReg=riscv?32:15,spReg=riscv?2:13;
  const preservedRegisters=riscv?[8,9,...Array.from({length:10},(_,i)=>i+18)]:Array.from({length:8},(_,i)=>i+4);
  const r=new Uint32Array(registerCount);
  if(initial){
    r.set(initial.regs);
  }else if(riscv){
    for(let i=0;i<32;i++){cancel();r[i]=i===0?0:await s.readReg('x'+i);}
  }else{
    for(let i=0;i<13;i++){cancel();r[i]=await s.readReg('R'+i);}
    r[14]=await s.readReg('LR');
  }
  r[spReg]=sp;r[pcReg]=pc;
  let state=r, returned=false, known=new Set(initial ? initial.known : Array.from({length:registerCount},(_,i)=>i));
  frames[0].regs=Array.from(r);frames[0].known=[...known];
  const seen=new Set([`${pc}:${sp}`]);
  try {
    while(frames.length<=depth){
      cancel();
      const at=even(state[pcReg])-(returned?(riscv?1:2):0);
      if(!executable(elf,at)) throw new Error('PC 不在 ELF 的可执行段中');
      const previousSp=state[spReg];
      let kind='cfi';
      const row=cfiRow(elf,at,{maxRegister:riscv?32:15});
      if(row){
        const next=await unwindCfi(state,known,row,readWord,valid,{registerCount,pcReg,spReg,preservedRegisters});
        frames[frames.length-1].cfa=next.cfa;
        state=next.regs;known=next.known;
      }else{
        if(riscv)throw new Error('ELF 缺少当前函数的 RISC-V DWARF CFI 展开行');
        kind='ehabi';
        const entry=exidxEntry(elf,at);
        if(!returned && even(state[15])===entry.start) throw new Error('停在函数入口，序言尚未执行；请单步到函数体后重试');
        // EHABI cannot describe intermediate prologue/epilogue positions.
        const ops=unwindBytes(elf,entry);
        const context={input:known};state=await unwindFrame(state,ops,readWord,valid,context);
        frames[frames.length-1].cfa=state[13];
        // Do not expose volatile caller values inherited from the callee.
        known=context.output;
      }
      if(frames.length>=depth)break;
      if(state[spReg]<previousSp) throw new Error('调用者 SP 倒退，栈或展开信息不一致');
      if(!riscv&&exceptionReturn(state[pcReg])){
        const excReturn=state[pcReg]>>>0;
        // MSP uses the unwound handler SP; PSP is a separate bounded stack region.
        const base=(state[15]&4)?await s.readReg('PSP'):state[13];
        const offset=(state[15]&16)?0:72;
        if(base%4||base+offset+36>0x100000000) throw new Error('异常栈地址无效');
        const allowed=(a,n)=>a>=base&&a+n<=base+stackBytes;
        if(!allowed(base+offset,32)) throw new Error('异常帧超出范围');
        const b=await s.memRead(base+offset,32); if(b.length!==32) throw new Error('异常帧短读');
        const v=Array.from({length:8},(_,i)=>word(b.subarray(i*4,i*4+4)));
        if(!executable(elf,even(v[6]))) throw new Error('异常帧 PC 不在 ELF 代码段');
        if(!(v[7]&0x01000000)) throw new Error('异常帧 xPSR Thumb 位无效');
        for(let i=0;i<4;i++) state[i]=v[i];
        state[12]=v[4];state[14]=v[5];state[15]=v[6];
        state[13]=base+offset+32+((v[7]&512)?4:0); kind='exception';
        // Changing to PSP cannot be safely followed using the original MSP bounds.
        frames.push({...decorate(s,state[15],state[13],kind),regs:Array.from(state),known:[0,1,2,3,12,13,14,15],
          exception:{return:excReturn,base,stack:(excReturn&4)?'PSP':'MSP',extended:offset!==0,xpsr:v[7],aligned:!!(v[7]&512)}});
        reason='已恢复异常硬件帧；跨栈后停止（当前读取边界属于原栈）'; break;
      }
      if(!state[pcReg] || state[pcReg]===0xffffffff) {reason='到达栈末端';break;}
      if(!riscv&&!(state[pcReg]&1)) throw new Error('返回地址缺少 Thumb 位');
      if(riscv&&(state[pcReg]&1))throw new Error('RISC-V 返回地址未按指令边界对齐');
      const key=`${state[pcReg]}:${state[spReg]}`;
      if(seen.has(key)) throw new Error('回溯没有进展或栈形成循环'); seen.add(key);
      if(!executable(elf,even(state[pcReg])-(riscv?1:2))) throw new Error('返回地址不在 ELF 代码段');
      frames.push({...decorate(s,state[pcReg],state[spReg],kind,true),regs:Array.from(state),known:[...known]}); returned=true;
    }
  } catch(e){if(e.cancelled) throw e;reason=e.message;}
  return {frames,reason,scan:false};
}

/** Hardware runner used by the existing stress entry point. No retries hide mismatches. */
import {confirmedM7BreakpointRace} from './dbg-breakpoint-proof.mjs';
import {FRAME_CASES,webVariables,compareFrames} from './dbg-frame-contract.mjs';
async function captureCheckpoint(address,ramStart,ramEnd,board,confirm){
 const d=window.__tools.dbg,s=d.session;
 const cmd=async line=>{const r=await d.runLine(line);if(r.error||r.cancelled)throw new Error(line+': '+(r.error||'cancelled'));return r;};
 await cmd('bd all');await cmd('b 0x'+address.toString(16));
 const erratumRecoveries=[];
 const pcNow=()=>((s.pc>>>0)&0xfffffffe)>>>0;
 const waitForStop=async timeoutMs=>{
  const end=Date.now()+timeoutMs;
  do{await new Promise(r=>setTimeout(r,20));await s.refresh();if(s.halted)break;}while(Date.now()<end);
  if(!s.halted)throw new Error('检查点暂停超时');
 };

 await s.exclusive(async()=>{
  await s.cont();await waitForStop(8000);
  while(pcNow()!==address){
   const race=await confirm(d,address,board);
   if(!race)break;
   erratumRecoveries.push(race);
   if(erratumRecoveries.length>4)throw new Error('Cortex-M7 3092511 连续误停超过 4 次，拒绝继续掩盖异常');
   // Arm erratum 3092511 can report the pending exception entry as the halt PC
   // even though the requested FPB breakpoint is stacked in the exception frame.
   // Resume only after the active comparator and the exact stacked PC agree.
   await s.run();await waitForStop(2000);
  }
 });
 if(pcNow()!==address)throw new Error('暂停 PC 不等于检查点: actual=0x'+pcNow().toString(16)+' expected=0x'+(address>>>0).toString(16));
 const snapshot=()=>s.exclusive(async()=>{
  const registers=[];let sp;
  if(s.arch.name==='riscv'){
   for(let i=0;i<32;i++)registers.push(await s.readReg('x'+i));
   registers.push(await s.readReg('pc'));sp=registers[2];
  }else{
   for(let i=0;i<16;i++)registers.push(await s.readReg('R'+i));
   for(const name of ['MSP','PSP','XPSR','CONTROL','PRIMASK','BASEPRI','FAULTMASK'])registers.push(await s.readReg(name));
   sp=registers[13];
  }
  const length=Math.min(512,ramEnd-sp);
  if(sp<ramStart||sp>=ramEnd||length<4)throw new Error('暂停栈不在测试板 RAM 范围');
  return {registers,stack:[...await s.memRead(sp,length)]};
 });
 const before=await snapshot(),bt=await cmd('bt 16'),frames=[];
 for(let i=0;i<bt.backtrace.frames.length;i++){
  const frame=bt.backtrace.frames[i],name=d.sym.funcAt(frame.lookup)?.name||'';
  if(!name.startsWith('engine_frame_'))break;
  const selected=await cmd('frame '+i);
  frames.push({name,pc:frame.pc,sp:frame.sp,rows:selected.locals.rows});
  const pressed=document.querySelector('#d-bt-list button[aria-pressed="true"]');
  if(pressed?.dataset.frame!==String(i))throw new Error('帧选中 UI 与会话不一致');
  if(frame.loc&&d.srcCur?.file!==frame.loc.file)throw new Error('帧切换后源码文件不匹配');
  if(frame.loc&&d.srcCur?.line!==frame.loc.line)throw new Error('帧切换后源码行不匹配');
 }
 for(let i=frames.length-1;i>=0;i--)await cmd('frame '+i);
 const after=await snapshot();
 if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('只读回溯/切帧修改了寄存器或栈');
 const leak=await window.__S.leak();
 if(leak.used!==1||leak.bps!==1||leak.extra!==0)throw new Error('栈帧压力期间硬件断点泄漏');
 return {pc:s.pc,frames,reason:bt.backtrace.reason,leak,m7ErratumRecoveries:erratumRecoveries};
}
async function staleChecks(){
 const d=window.__tools.dbg,s=d.session,failures=[];
 const bt=async()=>{const r=await d.runLine('bt 16');if(r.error)throw new Error(r.error);};
 // Same-PC same-value writes must invalidate caches, without altering test inputs.
 const writable=s.arch.name==='riscv'?'x8':'R0';
 await bt();await s.exclusive(async()=>s.writeReg(writable,await s.readReg(writable)));
 if(s._frames)failures.push('写寄存器未清缓存');
 await bt();await s.exclusive(async()=>{const sp=await s.readReg('SP');await s.memWrite(sp,await s.memRead(sp,4));});
 if(s._frames)failures.push('写内存未清缓存');
 await bt();const step=await d.runLine('s');if(step.error)throw new Error(step.error);
 if(s._frames)failures.push('单步未清缓存');
 const stale=await d.runLine('frame 1');if(!stale.error)failures.push('旧帧仍可选择');
 await bt();const continued=await d.runLine('c');if(continued.error)throw new Error(continued.error);
 if(s._frames)failures.push('继续未清缓存');
 await s.exclusive(async()=>s.halt());
 if(document.getElementById('d-locals')?.textContent.includes('帧 #'))failures.push('旧变量仍留在面板');
 await bt();const previous=d.sym;d.loadElfBuffer(previous.elf.b,'same ELF reload');
 if(s._frames)failures.push('重载 ELF 未清缓存');
 await bt();const reset=await d.runLine('reset halt');if(reset.error)throw new Error(reset.error);
 if(s._frames)failures.push('复位未清缓存');
 await bt();await d.disconnect();if(s._frames)failures.push('断开未清缓存');
 return failures;
}
export async function runFrameStress({cdp,oracle,board,rounds=200,code,ok,log,disconnectOnFinish=true}){
 const profile=(board==='6800evk')?{ramStart:0x00084000,ramEnd:0x00088000,entry:'riscv'}:
  board==='5301evklite'?{ramStart:0x00080300,ramEnd:0x000a0000,entry:'riscv'}:
  board==='h743'?{ramStart:0x20000000,ramEnd:0x20020000,entry:'arm'}:
  board==='f103cb'?{ramStart:0x20000000,ramEnd:0x20005000,entry:'arm'}:
  {ramStart:0x20000000,ramEnd:0x20010000,entry:'arm'};
 const results=[];
 try{
  if(!code?.some(s=>s.name==='.text'))throw new Error('缺少目标代码验证');
  const imageOnly = profile.entry==='riscv' && code.some(s =>
    s.addr < 0x90000000 && s.addr+s.bytes.length > 0x80000000);
  if(imageOnly){
   if(oracle.codeVerified!==true)throw new Error('RISC-V XIP 没有独立 GDB 代码校验记录；不能用 ELF 镜像自证板上代码');
   log('RISC-V XIP：GDB oracle 记录了独立代码校验；Web 读取的是 ELF 镜像，未独立验证当前板上 Flash。请使用本轮实板生成的 oracle。');
  }else{
  for(const section of code){
   for(let offset=0;offset<section.bytes.length;offset+=1024){
    const expected=section.bytes.slice(offset,offset+1024),address=section.addr+offset;
    const actual=await cdp.json(`window.__tools.dbg.session.exclusive(async()=>[...await window.__tools.dbg.session.memRead(${address},${expected.length})])`);
    if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('板上代码与 ELF 不同: '+section.name+'+'+offset);
   }
  }
  ok(true,'Web 独立核对板上 Flash 与当前 ELF 一致');
  }
  // Establish the same first visit to each checkpoint as the GDB collector.
   if(profile.entry==='riscv'){
    const reset=await cdp.json(`window.__tools.dbg.runLine('reset halt')`);
    if(reset.error)throw new Error(reset.error);
   }else{
    const reset=await cdp.json(`window.__S.resetToFirmware(${board==='f103ze'})`);
    if(reset.error)throw new Error(reset.error);
   }
  for(const c of FRAME_CASES){
   const expected=oracle.cases[c.id],start=Date.now();
    const captured=await cdp.json(`(${captureCheckpoint.toString()})(${expected.pc},${profile.ramStart},${profile.ramEnd},${JSON.stringify(board)},${confirmedM7BreakpointRace.toString()})`);
   const actual=captured.frames.map(f=>({...f,variables:webVariables(f.rows)}));
   // GDB may report a caller-saved parameter from a live volatile register
   // even when the leaf frame's CFI does not preserve it. Keep the web
   // unwinder fail-closed; the volatile stack copy remains compared exactly.
    const conservative=profile.entry==='arm'&&c.id==='leaf'?[{frame:1,name:'seed',reasonPattern:/^该帧寄存器 R[0-3] 不可恢复$/}]:[];
   const differences=compareFrames(actual,expected.frames,{allowConservativeUnavailable:conservative});
   const note=conservative.length?'（CFI 未保留调用者易失参数，网页按不可恢复处理）':'';
   ok(differences.length===0,`GDB 对照 ${c.id}: ${actual.length} 帧，逐帧参数/局部值${note}`,differences.join('；'));
   results.push({id:c.id,elapsedMs:Date.now()-start,frames:actual,differences,m7ErratumRecoveries:captured.m7ErratumRecoveries});
  }
  const c=oracle.cases.recursive;
  let m7ErratumRecoveries=0;
  for(let i=0;i<rounds;i++){
    const captured=await cdp.json(`(${captureCheckpoint.toString()})(${c.pc},${profile.ramStart},${profile.ramEnd},${JSON.stringify(board)},${confirmedM7BreakpointRace.toString()})`);
   m7ErratumRecoveries+=captured.m7ErratumRecoveries.length;
   const actual=captured.frames.map(f=>({...f,variables:webVariables(f.rows)})),diff=compareFrames(actual,c.frames);
   if(diff.length)throw new Error(`压力轮${i+1}: `+diff.join('；'));
   if((i+1)%20===0)log(`   栈帧压力 ${i+1}/${rounds}，无变量差异/寄存器或栈修改/比较器泄漏`);
  }
  const recursiveResult=results.find(result=>result.id==='recursive');
  if(recursiveResult){recursiveResult.pressureRounds=rounds;recursiveResult.pressureM7ErratumRecoveries=m7ErratumRecoveries;}
  ok(true,`${rounds} 轮递归栈回溯、正反切帧及 GDB 对照`,m7ErratumRecoveries?`按 Cortex-M7 断点/异常栈证据恢复 ${m7ErratumRecoveries} 次`:undefined);
  const stale=await cdp.json(`(${staleChecks.toString()})()`);
  ok(!stale.length,'写操作/单步/继续/重载 ELF/复位/断开清除旧帧和局部值',stale.join('；'));
 }catch(error){ok(false,'栈帧/局部变量硬件压力流程',error.message);results.push({error:error.message});}
 finally{
   await cdp.eval(`const d=window.__tools.dbg;if(d.session.connected){await d.session.exclusive(async()=>{await d.session.halt();await d.session.bpClear();});if(${JSON.stringify(disconnectOnFinish)})await d.disconnect();}return true;`).catch(e=>ok(false,'压力测试收尾',e.message));
 }
 return results;
}

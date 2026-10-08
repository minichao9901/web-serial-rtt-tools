import { $ } from '../ui/dom.js';
import { BUILD } from '../core/build.js';
import { DiagnosticHistory, makeReport } from '../diagnostics/report.js';
import { reportHtml, exportReport } from '../diagnostics/drawer.js';
import { captureFault, faultData, hex } from './fault.js';

export class FaultPanel {
  constructor(view){ this.view=view; this.history=new DiagnosticHistory(); this.snapshot=null; this.historical=false; this.autoKey=null; }
  init(){
    $('d-fault-read')?.addEventListener('click', ()=>this.view._act('读取异常现场', ()=>this.captureLocked()));
    $('d-fault-catch')?.addEventListener('change', async e=>{
      const enabled=e.target.checked;
      e.target.disabled=true;
      await this.view._act('设置 HardFault 捕获', ()=>this.setCatchLocked(enabled));
      e.target.checked=!!this.catchState?.confirmed; this.sync();
    });
    for(const [id,format] of [['d-fault-json','json'],['d-fault-md','md']]) $(id)?.addEventListener('click', ()=>{const r=this.report();if(r)exportReport(r,format);});
    this.sync();
  }
  invalidate(reason){
    if(this.snapshot && !this.historical){ this.historical=true; this.history.note('historical', reason || '目标状态已变更，保留历史现场'); this.render(); }
    this.autoKey=null;
  }
  sync(){
    const s=this.view.session;
    if(this.snapshot && (!s.connected || !s.halted || s!==this.origin || (this.snapshot.pc!=null && s.pc!==this.snapshot.pc) || this.view.sym!==this.elf))this.invalidate();
    if(!s.connected || !s.halted)this.autoKey=null;
    if($('d-fault-read'))$('d-fault-read').disabled=!s.connected || !s.halted || s.busy;
    if($('d-fault-catch'))$('d-fault-catch').disabled=!s.connected || s.arch.name!=='arm' || s.busy;
  }
  async setCatchLocked(enabled){
    const s=this.view.session;
    if(!s.connected || s.arch.name!=='arm')throw new Error('HardFault 捕获仅支持已连接的 Cortex-M3/M4/M7');
    if(!enabled){await this.restoreCatchLocked(false);return;}
    if(this.catchState?.confirmed)return;
    if(this.catchState)await this.restoreCatchLocked(false);
    const b=await s.probe.readMemDiagnostic(0xe000ed00,4), cpuid=new DataView(b.buffer,b.byteOffset,4).getUint32(0,true);
    if(![0xc23,0xc24,0xc27].includes((cpuid>>>4)&0xfff))throw new Error('这个内核未支持 HardFault 捕获');
    try{
      const original=await s.probe.setHardFaultCatch(true);this.catchState={session:s,original,confirmed:true};
    }catch(e){if(e.originalCatch!=null)this.catchState={session:s,original:e.originalCatch,confirmed:false};throw e;}
    this.history.note('vector-catch','启用 HardFault 捕获（DEMCR.VC_HARDERR），异常发生时内核将停止');
  }
  async restoreCatchLocked(disconnecting=true){
    if(!this.catchState)return;
    const {session,original}=this.catchState;
    try{await session.probe.setHardFaultCatch(original);this.catchState=null;this.history.note('vector-catch','HardFault 捕获恢复原位');}
    catch(e){
      this.history.note('vector-catch-error','恢复 HardFault 捕获失败：'+e.message,'error');
      if(!disconnecting)throw e;
      this.view._out('恢复 HardFault 捕获失败，目标可能保留捕获位：'+e.message,'warn');this.catchState=null;
    }
    if($('d-fault-catch'))$('d-fault-catch').checked=!!this.catchState?.confirmed;
  }
  async afterStopLocked(){
    const s=this.view.session, xpsr=s.regs.find(r=>r.name.toUpperCase()==='XPSR')?.value;
    const inFault=s.arch.name==='arm' && [3,4,5,6].includes((xpsr ?? 0)&511);
    if(!inFault)return;
    const key=`${this.view._connectionGen}:${s.pc}:${xpsr}`;
    if(this.autoKey===key)return this.snapshot;
    this.autoKey=key;
    await this.captureLocked();
    this.view._dockSelect('fault');
    return this.snapshot;
  }
  async captureLocked(){
    const s=this.view.session, generation=this.view._connectionGen, elf=this.view.sym, elfName=this.view.elfName;
    if($('d-fault-result'))$('d-fault-result').textContent='正在读取异常现场…';
    const snapshot=await captureFault(s);
    if(snapshot.observedHalted===false && this.view.session===s)s.halted=false;
    if(snapshot.error){
      this.view._stopWatch(); this.view.rttStop();
      this.view._out('异常现场读取不完整，已停止后台观察与 RTT 读取；未重新初始化或复位目标：'+snapshot.error,'warn');
    }
    snapshot.catchConfigured=!!this.catchState?.confirmed;
    this.snapshot=snapshot; this.origin=s; this.elf=elf; this.elfName=elfName;
    this.historical=this.view.session!==s || !s.connected || !s.halted || this.view._connectionGen!==generation || this.view.sym!==elf || (snapshot.pc!=null && snapshot.pc!==s.pc) || /现场已过期/.test(snapshot.error||'');
    this.history.note('capture', snapshot.error ? `读取不完整：${snapshot.error}` : '异常现场已读取', snapshot.error ? 'warn' : 'info');
    this.render(); return snapshot;
  }
  report(){
    if(!this.snapshot)return null;
    return makeReport('fault','异常诊断报告',faultData(this.snapshot,this.historical),this.history,
      {Web版本:BUILD, ELF:this.elfName || '未载入', 后端:this.origin.backendName || this.origin.arch.name,
        数据:this.origin.name?.includes('mock') || this.origin.probe?.constructor?.name==='MockTarget' ? '模拟目标' : '真实目标',
        浏览器:navigator.userAgent});
  }
  render(){
    const box=$('d-fault-result'), r=this.report(); if(!box || !r)return;
    box.innerHTML=reportHtml(r);
    const snap=this.snapshot;
    const stack=document.createElement('div');
    const heading=document.createElement('p');heading.className='hint';heading.textContent=snap.arch==='riscv'?'机器级 trap 保存位置（历史 CSR）':'异常前调用链／保存位置';stack.append(heading);
    const frames=snap.frames?.length ? snap.frames : snap.frame ? [{...snap.frame,name:'异常帧候选（未验证）'}] : [];
    if(snap.arch==='riscv' && snap.raw.mepc!=null)frames.push({pc:snap.raw.mepc,name:'mepc（不保证当前 trap）',loc:this.elf?.at?.(snap.raw.mepc)||null});
    for(const [i,frame] of frames.entries()){
      const b=document.createElement('button'); b.className='diag-frame';
      const loc=frame.loc || this.elf?.at?.(frame.pc & 0xfffffffe);
      b.textContent=`#${i} ${hex(frame.pc)} ${frame.name || ''}${loc ? ' '+loc.file+':'+loc.line : ''}`;
      b.disabled=!loc || this.view.sym!==this.elf; b.title=(loc ? `${loc.file}:${loc.line} · ` : '')+'查看源码位置（不改变寄存器或选择调试栈帧）';
      if(loc)b.onclick=()=>this.view.showSource(loc.file,loc.line);
      stack.append(b);
    }
    if(!frames.length){const p=document.createElement('p');p.className='hint';p.textContent='没有可验证的异常前调用链。';stack.append(p);}
    box.prepend(stack);
    for(const id of ['d-fault-json','d-fault-md'])if($(id))$(id).disabled=false;
  }
}

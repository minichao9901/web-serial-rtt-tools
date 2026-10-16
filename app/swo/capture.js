import {waitMs} from '../core/pace.js';
import {WebUsbDapProbe} from '../rtt/dap-webusb.js';
import {SerialSession} from '../serial/session.js';
import {MAX_RAW} from './recording.js';
import {inspectTarget} from './target.js';
import {TraceRoute} from './route.js';
import {tracePlan} from './planning.js';
export {tracePlan} from './planning.js';
import {SwoReceiver} from './receiver.js';
import {matchedOptions} from './matching.js';
import {decodeFpCtrl,encodeComparator,canBreak,compAddr,FPB,FP_CTRL_KEY} from '../dbg/bp.js';
const R={demcr:0xe000edfc,dwt:0xe0001000,cyccnt:0xe0001004,itm:0xe0000e80,ter:0xe0000e00,tpr:0xe0000e40,acpr:0xe0040010,sppr:0xe00400f0,ffcr:0xe0040304,dbg:0xe0042004};
export class SwoCapture {
  constructor(){this.serial=new SerialSession();this.probe=null;this.running=false;this.busy=false;this.saved=null;this.chunks=[];this.bytes=0;this.metadata={};this.onChange=()=>{};this.collecting=false;this._epoch=0;this.entryLease=null;this.entryState=null;this.entryBoundary=null;this.setupFailed=false;this.targetWasRunningAtStart=null;
    this.serial.on('data',b=>{this.lastRxAt=performance.now();if(!this.collecting)return;const room=MAX_RAW-this.bytes;if(room){const part=b.slice(0,room);this.chunks.push(part);this.bytes+=part.length;}if(b.length>room){this.metadata.limitReached=true;this.stop().catch(e=>this.onError?.(e));}});
    this.serial.on('error',e=>{if(this.collecting){(this.metadata.transportGaps??=[]).push({offset:this.bytes,reason:String(e.message).slice(0,240)});if(this.metadata.transportGaps.length>=100){this.metadata.errorLimitReached=true;this.stop().catch(error=>this.onError?.(error));}}this.onError?.(e);});
    this.serial.on('close',()=>{if(this.running&&!this._stopTask){this.metadata.disconnected=true;this.stop().catch(e=>this.onError?.(e));}});
  }
  get active(){return this.busy||this.running||!!this.probe||this.serial.isOpen;}
  createReceiver(){return new SwoReceiver();}
  async read(a){const b=await this.probe.readMemDiagnostic(a,4);return new DataView(b.buffer,b.byteOffset,4).getUint32(0,true);}
  async write(a,v){const b=new Uint8Array(4);new DataView(b.buffer).setUint32(0,v,true);await this.probe.writeMem(a,b);}
  async waitRegister(address,mask,value,alive=()=>{}){for(let i=0;i<100;i++){alive();if(((await this.read(address))&mask)===value)return;await waitMs(5);}throw Error(`读取目标断点状态超时：0x${address.toString(16)}`);}
  async readCorePc(alive=()=>{}){await this.write(0xe000edf4,15);await this.waitRegister(0xe000edf0,1<<16,1<<16,alive);return (await this.read(0xe000edf8))&~1;}
  async clearEntryBreakpoint(){
    const lease=this.entryLease;if(!lease)return;
    if((await this.read(lease.slot))!==lease.encoded)throw Error('临时起点断点槽位已被其他调试操作改变，拒绝覆盖');
    await this.write(lease.slot,lease.before);
    if(!lease.controlEnabled){let active=false;for(let i=0;i<lease.capacity;i++)if(await this.read(compAddr(i))&1)active=true;if(!active)await this.write(FPB.CTRL,FP_CTRL_KEY);}
    this.entryLease=null;
  }
  async runToEntry(address,label,alive=()=>{},timeoutMs=15000){
    address=Number(address);if(!Number.isInteger(address)||address<0||address>0xffffffff)throw Error('SWO 采集断点地址无效');address=(address>>>0)&~1;
    const wasHalted=await this.probe.isHalted(),state={address,label,wasHalted,hit:false};this.entryState=state;
    if(wasHalted){const pc=await this.readCorePc(alive);if(pc===address){state.hit=true;return {address,hitPc:pc,label,wasHalted,alreadyAtEntry:true};}}
    const raw=(await this.read(FPB.CTRL))>>>0,caps=decodeFpCtrl(raw),capacity=Math.min(16,caps.numCode);
    if(!capacity)throw Error('目标没有可用的 FPB 硬件断点');
    if(!canBreak(address,caps.rev))throw Error(`FPB rev${caps.rev} 不支持起点 0x${address.toString(16)}`);
    let slot=null,before=0,foreign=false;
    for(let i=0;i<capacity;i++){const candidate=compAddr(i),value=(await this.read(candidate))>>>0;if(value&1){foreign=true;}else if(slot===null){slot=candidate;before=value;}}
    if(!caps.enabled&&foreign)throw Error('FPB 已关闭但保留着其他断点；为避免覆盖，不能启用采集起点断点');
    if(slot===null)throw Error('没有空闲硬件断点槽位；请先释放一个断点');
    const encoded=encodeComparator(address,caps.rev);this.entryLease={slot,before,encoded,capacity,controlEnabled:caps.enabled};
    try{
      await this.write(slot,encoded);if(!caps.enabled)await this.write(FPB.CTRL,FP_CTRL_KEY|1);
      if((await this.read(slot))!==encoded||!((await this.read(FPB.CTRL))&1))throw Error('采集起点断点写入回读失败');
      if(wasHalted)await this.probe.run();
      const until=Date.now()+timeoutMs;
      for(;;){alive();if(await this.probe.isHalted())break;if(Date.now()>until)throw Error(`等待命中起点断点超时：${label||'0x'+address.toString(16)}`);await waitMs(20);}
      const pc=await this.readCorePc(alive);if(pc!==address){state.unexpectedStop=true;throw Error(`目标停在 0x${pc.toString(16)}，不是所选采集起点 0x${address.toString(16)}`);}
      state.hit=true;state.hitPc=pc;
    }catch(error){
      const cleanup=[];try{await this.clearEntryBreakpoint();}catch(e){cleanup.push(e);}
      if(wasHalted)try{if(!await this.probe.isHalted())await this.probe.halt();}catch(e){cleanup.push(e);}
      if(cleanup.length)throw new AggregateError([error,...cleanup],'等待采集起点失败，且断点/目标状态清理未完全确认');throw error;
    }
    await this.clearEntryBreakpoint();return {address,hitPc:state.hitPc,label,wasHalted,alreadyAtEntry:false};
  }
  async readClockConfig(address=0x40021004){
    // Probe handoff can yield a stale peripheral read. Confirm the fixed RCC config
    // before deriving a core clock; unstable clocks must never enable trace.
    let previous=null,same=0;
    for(let i=0;i<6;i++){const value=await this.read(address);same=value===previous?same+1:1;previous=value;if(same===3)return value;}
    throw Error('RCC 时钟配置读回不稳定，请停止其他调试连接后重试');
  }
  async openProbe(){
    const devices=await WebUsbDapProbe.authorized();
    this.probe=devices.length===1?await WebUsbDapProbe.open(devices[0],{clockKhz:1000,skipClearHalt:true}):await WebUsbDapProbe.request(false,{clockKhz:1000,skipClearHalt:true});
  }
  async targetInfo(options={}){
    return inspectTarget(a=>this.read(a),a=>this.readClockConfig(a),options);
  }
  async identifyTarget(options,alive=()=>{}){
    for(let attempt=1;attempt<=3;attempt++){
      alive();try{return {...await this.targetInfo(options),detectionAttempts:attempt};}
      catch(e){
        if(attempt===3||!/RCC 时钟.*(无效|不稳定)/.test(e.message))throw e;
        // Retry a read-only transport handoff; never halt/reset or modify target clocks.
        await this.probe.disconnect();this.probe=null;alive();await this.openProbe();alive();
      }
    }
  }
  async verifiedTarget(options,alive,onIdentified=()=>{}){
    for(let attempt=1;attempt<=2;attempt++){
      const target=await this.identifyTarget(options,alive);
      await onIdentified(target,attempt);
      try{if(options.verifyElf)await options.verifyElf(this.probe);alive();return {...target,elfVerificationAttempts:options.verifyElf?attempt:0};}
      catch(error){
        if(attempt===2||error.code!=='SWO_ELF_VERIFY')throw error;
        // A transport handoff can produce persistent stale Flash reads. Reconnect
        // once before any trace writes; still reject genuinely different code.
        alive();await this.probe.disconnect();this.probe=null;alive();await this.openProbe();alive();
      }
    }
  }
  async inspect(options={}){
    if(this.active||this._startTask||this._stopTask)throw Error('请先停止记录再识别目标');
    this.busy=true;this.onChange();
    const setup=async lease=>{try{await this.openProbe();lease?.assert();return await this.identifyTarget({...options,autoClock:false,coreHz:null,traceHz:null},()=>lease?.assert());}finally{if(this.probe){await this.probe.disconnect();this.probe=null;}this.busy=false;this.onChange();}};
    this._startTask=this.probeManager?this.probeManager.run('swo',setup,{reason:'识别 SWO 目标',recovery:true}):setup();
    try{return await this._startTask;}finally{this._startTask=null;this.busy=false;this.onChange();}
  }
  async resetToEntry(options={}){
    if(this.active||this._startTask||this._stopTask||this._resetTask)throw Error('采样连接正在使用或切换中');
    if(!Number.isInteger(options.entryAddress))throw Error('请先选择采集起点');
    this._onTarget=options.onTarget;const token=++this._epoch;this.busy=true;this.startPhase='连接探针';this.onChange();
    const setup=async lease=>{
      const alive=()=>{lease?.assert();if(token!==this._epoch)throw Error('复位操作已取消');},phase=text=>{this.startPhase=text;this.onChange();};
      let wasHalted=null,resetIssued=false,demcr=null;
      try{
        alive();phase('连接探针');await this.openProbe();alive();
        phase('识别目标并核对 ELF');const target=await this.identifyTarget(options,alive);
        if(!target.captureSupported)throw Error('该目标尚未适配 SWO 起点控制');
        options.onTarget?.(target);wasHalted=await this.probe.isHalted();if(!wasHalted)await this.probe.halt();
        if(options.verifyElf)await options.verifyElf(this.probe);alive();

        const address=(options.entryAddress>>>0)&~1,raw=(await this.read(FPB.CTRL))>>>0,caps=decodeFpCtrl(raw),capacity=Math.min(16,caps.numCode);
        if(!capacity)throw Error('目标没有可用的 FPB 硬件断点');
        if(!canBreak(address,caps.rev))throw Error(`FPB rev${caps.rev} 不支持起点 ${hex(address)}`);
        let slot=null,before=0,foreign=false;
        for(let i=0;i<capacity;i++){const candidate=compAddr(i),value=(await this.read(candidate))>>>0;if(value&1)foreign=true;else if(slot===null){slot=candidate;before=value;}}
        if(!caps.enabled&&foreign)throw Error('FPB 已关闭但保留着其他断点；为避免覆盖，不能启用复位起点断点');
        if(slot===null)throw Error('没有空闲硬件断点槽位；请先释放一个断点');
        const encoded=encodeComparator(address,caps.rev);this.entryLease={slot,before,encoded,capacity,controlEnabled:caps.enabled};
        await this.write(slot,encoded);if(!caps.enabled)await this.write(FPB.CTRL,FP_CTRL_KEY|1);
        if((await this.read(slot))!==encoded||!((await this.read(FPB.CTRL))&1))throw Error('复位起点断点写入回读失败');

        demcr=await this.read(R.demcr);
        await this.write(R.demcr,demcr&~1); // Disable vector catch; let the reset handler reach the selected business entry.
        phase('软件复位并等待所选起点');resetIssued=true;await this.write(0xe000ed0c,0x05fa0004);
        const until=Date.now()+(options.entryTimeoutMs||15000);
        for(;;){alive();if(await this.probe.isHalted())break;if(Date.now()>until)throw Error(`复位后等待起点超时：${options.entryLabel||hex(address)}`);await waitMs(20);}
        const pc=await this.readCorePc(alive);if(pc!==address)throw Error(`复位后停在 ${hex(pc)}，不是所选起点 ${hex(address)}`);
        await this.clearEntryBreakpoint();await this.write(R.demcr,demcr);if(await this.read(R.demcr)!==demcr)throw Error('复位后 DEMCR 恢复回读不一致');demcr=null;
        return {address,hitPc:pc,label:options.entryLabel||hex(address),alreadyAtEntry:false,reset:true,wasHaltedBeforeReset:wasHalted};
      }catch(error){
        const cleanup=[];
        if(this.entryLease)try{await this.clearEntryBreakpoint();}catch(e){cleanup.push(e);}
        if(demcr!==null)try{await this.write(R.demcr,demcr);if(await this.read(R.demcr)!==demcr)throw Error('DEMCR 恢复回读不一致');}catch(e){cleanup.push(e);}
        if(this.probe)try{if(resetIssued){if(!await this.probe.isHalted())await this.probe.halt();}else if(wasHalted===false&&await this.probe.isHalted())await this.probe.run();}catch(e){cleanup.push(e);}
        if(cleanup.length)throw new AggregateError([error,...cleanup],'复位至起点失败，且断点/目标状态清理未完全确认');throw error;
      }finally{
        try{if(this.probe){await this.probe.disconnect();this.probe=null;}}
        finally{this.busy=false;this.startPhase=null;this.onChange();}
      }
    };
    this._resetTask=this.probeManager?this.probeManager.run('swo',setup,{reason:'复位并停在 SWO 采集起点',recovery:true}):setup();
    try{return await this._resetTask;}finally{this._resetTask=null;this.busy=false;this.startPhase=null;this.onChange();}
  }
  async start(options){
    if(this.active||this._startTask||this._stopTask)throw Error('采样连接正在使用或切换中');
    this._onTarget=options.onTarget;let plan;if(options.targetClockHz)throw Error('目标主频由目标程序负责，本页不修改目标时钟');if(!options.autoClock&&!options.autoBaud)plan=tracePlan(options);if(!options.port)throw Error('请先选择 VCOM 串口');if(!Number.isInteger(options.entryAddress)&&!options.allowUnboundedStart)throw Error('请先载入匹配 ELF，并设置函数或源码行断点作为采集起点');
    this.entryState=null;this.entryBoundary=null;this.setupFailed=false;this.targetWasRunningAtStart=null;
    const token=++this._epoch;this.busy=true;this.startPhase='连接探针';this._startTime=null;this.onChange();
    const setup=async lease=>{const alive=()=>{lease?.assert();if(token!==this._epoch)throw Error('记录启动已取消');},phase=text=>{this.startPhase=text;this.onChange();};
      try{
        alive();phase('连接探针');await this.openProbe();alive();
        phase('识别目标时钟并核对 ELF');
        const target=await this.verifiedTarget(options,alive,async found=>{
          if(found.traceReady===false)throw Error('目标 PLL1 R 输出未启用，请由目标程序配置稳定的 SWO 输入时钟');
          if(!found.captureSupported)throw Error('已识别内核，但该型号的 SWO 启用步骤 / DWT PC 采样尚未适配');
          if(Number.isInteger(options.entryAddress)){
            if(this.targetWasRunningAtStart===null)this.targetWasRunningAtStart=!(await this.probe.isHalted());
            if(this.targetWasRunningAtStart&&!await this.probe.isHalted())await this.probe.halt();
          }
        });
        if(target.traceReady===false)throw Error('目标 PLL1 R 输出未启用，请由目标程序提供稳定的 SWO 输入时钟');
        if(!target.captureSupported)throw Error('已识别内核，但该型号的 SWO 启用步骤 / DWT PC 采样尚未适配');
        const desired={...options,coreHz:target.coreHz,traceHz:target.traceHz};
        let matched=desired;
        if(options.receiverMode!==undefined){this.receiver=this.createReceiver();await this.receiver.open(this.probe.device?.serialNumber);alive();this.receiverSources=await this.receiver.sources();matched=matchedOptions(desired,this.receiverSources.frequencies);}
        plan=tracePlan(matched);
        const wasHalted=await this.probe.isHalted();if(!Number.isInteger(options.entryAddress)&&wasHalted)throw Error('目标处于暂停状态；从当前运行位置采集已关闭，请设置采集起点断点');
        if(Number.isInteger(options.entryAddress))this.entryState={wasHalted,hit:false};
        this.clockCheck={registers:target.registers,cfgr:target.cfgr,knownHz:target.knownHz,traceHz:target.traceHz};
        options.onTarget?.(target);
        this.registers={...R};delete this.registers.dbg;
        if(target.profile.startsWith('stm32h7')){this.registers.acpr=0x5c003010;this.registers.sppr=0x5c0030f0;delete this.registers.ffcr;}
        const saved={demcr:await this.read(R.demcr)};
        this.traceDemcr=saved.demcr;await this.write(R.demcr,saved.demcr|0x01000000);
        this.route=new TraceRoute(this,target.profile);await this.route.prepare();
        for(const [name,addr]of Object.entries(this.registers))if(name!=='demcr')saved[name]=await this.read(addr);
        this.wasLocked=!!((await this.read(0xe0000fb4))&2);this.saved=saved;
        await this.write(R.demcr,this.saved.demcr|0x01000000);await this.write(0xe0000fb0,0xc5acce55);
        await this.write(R.dwt,this.saved.dwt&~((1<<12)|(1<<16)));await this.write(R.itm,0);
        if(Number.isInteger(options.entryAddress)){phase('运行至采集起点断点');this.entryBoundary=await this.runToEntry(options.entryAddress,options.entryLabel,alive,options.entryTimeoutMs||15000);this.entryBoundary.targetWasRunningAtStart=this.targetWasRunningAtStart;phase('起点已命中，准备 SWO 接收');}
        await this.route.enable();await this.write(this.registers.acpr,plan.acpr);await this.write(this.registers.sppr,2);if(this.registers.ffcr)await this.write(this.registers.ffcr,0x100);
        await this.write(R.ter,plan.itm?0xffffffff:0);await this.write(R.tpr,0);
        // Receiver opens after the pin is quiet, and drains old UART bytes before enabling ITM.
        let receiverStatus=null;
        if(this.receiver){receiverStatus=await this.receiver.prepare(plan.baudRate,options.receiverMode);alive();
          if(Math.abs(receiverStatus.actualBaud-plan.baudRate)/plan.baudRate>.005)throw Error('目标与探针波特率偏差超过 0.5%');
          this.receiverPulse=setInterval(()=>{if(this._heartbeatTask)return;this._heartbeatTask=this.receiver.heartbeat().then(s=>{if(s.actualBaud!==receiverStatus.actualBaud||s.uartHz!==receiverStatus.uartHz)throw Error('探针时钟意外改变');}).catch(e=>{this.metadata.receiverError=e.message;this.onError?.(e);this.stop().catch(error=>this.onError?.(error));}).finally(()=>{this._heartbeatTask=null;});},1000);
        }
        phase('打开串口并确认 SWO 线路静止');await this.serial.open(options.port,{baudRate:this.receiver?Math.round(plan.baudRate):plan.requestedBaudRate,owner:'swo'});alive();this.lastRxAt=performance.now();for(let i=0;i<20;i++){await waitMs(30);alive();if(performance.now()-this.lastRxAt>=150)break;if(i===19)throw Error('SWO 引脚关闭后接收仍未安静，请检查其他 trace 连接');}
        if(this.receiver){const actual=await this.receiver.heartbeat();if(actual.actualBaud!==receiverStatus.actualBaud||actual.uartHz!==receiverStatus.uartHz)throw Error('串口打开后探针配置改变');const d=await this.receiver.hid.xfer(0x18),v=new DataView(d.buffer,d.byteOffset+2);if(v.getUint32(24,true)||v.getUint32(12,true)!==actual.actualBaud||v.getUint32(16,true)!==actual.osr)throw Error('UART 线路配置回读失败');}
        const receiverBaseline=this.receiver?await this.receiver.diagnostics():null;
        this.chunks=[];this.bytes=0;this.metadata={receiverBaseline,format:'swo-pc-v1',startAligned:true,plan,startedAt:null,clockCheck:this.clockCheck,receiver:receiverStatus,receiverSources:this.receiverSources||null,target:{...target,probe:this.probe.device?.serialNumber||''},elfSha256:options.elfSha256||null,entryBreakpoint:this.entryBoundary,transportGaps:[]};
        this.collecting=true;phase('启用 PC 采样并继续目标');
        const mask=0x007f1fff;await this.write(R.itm,plan.timestamps?0x1000f:0x1000d);await this.write(R.dwt,(this.saved.dwt&~mask)|1|(plan.post<<1)|(plan.post<<5)|(plan.tap<<9)|(1<<10)|(1<<12)|(plan.exceptions?(1<<16):0));
        alive();
        this.metadata.configReadback={dwt:await this.read(R.dwt),itm:await this.read(R.itm),acpr:await this.read(this.registers.acpr),sppr:await this.read(this.registers.sppr),dbg:await this.read(this.route.dbg)};
        const cfg=this.metadata.configReadback,expected=1|(plan.post<<5)|(plan.tap<<9)|(1<<10)|(1<<12)|(plan.exceptions?(1<<16):0);
        if(cfg.acpr!==plan.acpr||cfg.sppr!==2||(cfg.itm&0x1000f)!==(plan.timestamps?0x1000f:0x1000d)||(cfg.dwt&0x11fe1)!==expected||(target.profile.startsWith('stm32h7')?(cfg.dbg&0x700000)!==0x700000:(cfg.dbg&0xe0)!==0x20))throw Error('SWO 配置回读失败');
        if(Number.isInteger(options.entryAddress))await this.probe.run();
        this.setupFailed=false;this.running=true;this._startTime=performance.now();this.metadata.startedAt=new Date().toISOString();this.timer=setTimeout(()=>this.stop().catch(e=>this.onError?.(e)),plan.seconds*1000);this.pulse=setInterval(()=>this.onChange(),200);
      }catch(error){this.setupFailed=true;try{await this._close();}catch(cleanup){this.probeManager?.fail('swo',cleanup);throw new AggregateError([error,cleanup],'启动失败且 trace 配置未确认恢复');}throw error;}
      finally{this.busy=false;this.startPhase=null;this.onChange();}
    };
    this._startTask=this.probeManager?this.probeManager.run('swo',setup,{reason:'SWO 记录需要 SWD 与 VCOM',recovery:true}):setup();
    try{return await this._startTask;}finally{this._startTask=null;}
  }
  async _close(){
    clearTimeout(this.timer);clearInterval(this.pulse);clearInterval(this.receiverPulse);if(this._heartbeatTask)await this._heartbeatTask;let errors=[];
    if(this.entryLease)try{await this.clearEntryBreakpoint();}catch(e){errors.push(e);}
    if(this.probe&&this.saved){
      try{
        await this.route?.ensureAccess();await this.write(0xe0000fb0,0xc5acce55);
        // Stop PC/exception producers before removing software phase markers.
        // The opposite order leaves unlabelled PC samples during SWD teardown.
        await this.write(R.dwt,this.saved.dwt&~((1<<12)|(1<<16)));await this.write(R.ter,0);
        // Drain valid queued packets while NRZ remains enabled. Disabling ITM
        // first can change the SWO idle level and create UART break bytes.
        this.lastRxAt=performance.now();for(let i=0;i<10;i++){await waitMs(20);if(performance.now()-this.lastRxAt>=60)break;if(i===9)this.metadata.endAligned=false;}
        if(this.receiver&&this.metadata.receiverBaseline){const current=await this.receiver.diagnostics();this.metadata.receiverDiagnostics=current;this.metadata.receiverErrors=Object.fromEntries(Object.entries(current).map(([k,v])=>[k,(v-this.metadata.receiverBaseline[k])>>>0]));}
        this.collecting=false;await this.write(R.itm,0);
      }catch(e){errors.push(e);}
      this.collecting=false;
      // Restore producers last; a counter that was running is never rewound.
      for(const name of ['acpr','sppr','ffcr','ter','tpr','dwt','itm'].filter(n=>this.registers[n]))try{await this.write(this.registers[name],this.saved[name]);}catch(e){errors.push(e);}
      if(!(this.saved.dwt&1))try{await this.write(R.cyccnt,this.saved.cyccnt);}catch(e){errors.push(e);}
      for(const name of ['acpr','sppr','ffcr','ter','tpr','dwt','itm'].filter(n=>this.registers[n]))try{const mask=name==='dwt'?~0x1e:name==='ffcr'?~0x40:name==='itm'?~0x800000:-1;if(((await this.read(this.registers[name]))&mask)!==(this.saved[name]&mask))throw Error(name+' 恢复回读不一致');}catch(e){errors.push(e);}
      if(this.wasLocked&&!errors.length)try{await this.write(0xe0000fb0,0);}catch(e){errors.push(e);}
    }
    this.collecting=false;this.running=false;
    try{await this.serial.close();}catch(e){errors.push(e);}
    if(this.receiver)try{await this.receiver.close();this.receiver=null;this.metadata.receiverRestored=true;}catch(e){errors.push(e);}
    if(this.route&&!errors.length)try{await this.route.restore();this.route=null;}catch(e){errors.push(e);}
    if(this.traceDemcr!==undefined&&!errors.length)try{await this.write(R.demcr,this.traceDemcr);if(await this.read(R.demcr)!==this.traceDemcr)throw Error('DEMCR 恢复回读不一致');this.traceDemcr=undefined;}catch(e){errors.push(e);}
    if(!errors.length&&this.setupFailed&&!this.entryState?.unexpectedStop&&this.probe)try{
      if(this.targetWasRunningAtStart&&await this.probe.isHalted())await this.probe.run();
      else if(this.targetWasRunningAtStart===false&&this.entryState?.hit&&!await this.probe.isHalted())await this.probe.halt();
    }catch(e){errors.push(e);}

    if(errors.length){this.metadata.restoreError=errors.map(e=>e.message).join('; ');throw new AggregateError(errors,'Trace 配置恢复失败，快照已保留；请检查连接并重试停止');}
    if(this.probe){await this.probe.disconnect();this.probe=null;}
    this.saved=null;this.entryState=null;this.entryBoundary=null;this.targetWasRunningAtStart=null;delete this.metadata.restoreError;this.metadata.restored=true;
  }
  async stop(){
    if(this._stopTask)return this._stopTask;
    this._epoch++;this.probeManager?.cancel('swo');
    this._stopTask=(async()=>{try{if(this._startTask)await this._startTask.catch(()=>{});if(this._resetTask)await this._resetTask.catch(()=>{});if(this._startTime)this.metadata.elapsedMs=performance.now()-this._startTime;await this._close();this.probeManager?.forget('swo');}
      catch(e){this.probeManager?.fail('swo',e);throw e;}finally{this.onChange();}})();
    try{await this._stopTask;}finally{this._stopTask=null;}
  }
  raw(){const b=new Uint8Array(this.bytes);let p=0;for(const x of this.chunks){b.set(x,p);p+=x.length;}return b;}
}

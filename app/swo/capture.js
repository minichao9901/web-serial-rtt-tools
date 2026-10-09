import {WebUsbDapProbe} from '../rtt/dap-webusb.js';
import {SerialSession} from '../serial/session.js';
import {MAX_RAW} from './recording.js';
import {stm32f1Info} from './target.js';
import {SwoReceiver} from './receiver.js';
import {matchedOptions} from './matching.js';
import {TargetClock} from './target-clock.js';
const R={demcr:0xe000edfc,dwt:0xe0001000,cyccnt:0xe0001004,itm:0xe0000e80,ter:0xe0000e00,tpr:0xe0000e40,acpr:0xe0040010,sppr:0xe00400f0,ffcr:0xe0040304,dbg:0xe0042004};
export function tracePlan({coreHz,baudRate,periodCycles=4096,seconds=5,itm=false,exceptions=false,timestamps=true,allowBaudRounding=false}={}){
  for(const [name,v] of Object.entries({coreHz,baudRate,periodCycles,seconds}))if(!Number.isFinite(v)||v<=0)throw Error(name+' 必须为正数');
  if(coreHz>72000000||coreHz<1000000||seconds>120)throw Error('F103 核心频率须为 1–72 MHz，时长至多 120 秒');
  let tap=periodCycles<=1024&&periodCycles%64===0?0:1,unit=tap?1024:64,n=periodCycles/unit;
  if(!Number.isInteger(n)||n<1||n>16)throw Error('采样间隔必须为 64 或 1024 周期的 1–16 倍');
  if(baudRate>30000000)throw Error('SWO 波特率最高为 30 Mbps');
  const requestedBaudRate=baudRate,exactDivider=coreHz/baudRate,divider=allowBaudRounding?Math.round(exactDivider):exactDivider;
  if(!Number.isInteger(divider)||divider<1||divider>8192)throw Error('核心时钟必须能整除 SWO 波特率（分频 1–8192）');
  baudRate=coreHz/divider;const baudError=(baudRate-requestedBaudRate)/requestedBaudRate;
  if(Math.abs(baudError)>.05)throw Error('目标 SWO 与请求波特率偏差超过 5%，请降低波特率或调整目标主频');
  return {coreHz,baudRate,requestedBaudRate,baudError,periodCycles,seconds,itm:!!itm,exceptions:!!exceptions,timestamps:!!timestamps,tap,post:n-1,acpr:divider-1,samplesHz:coreHz/periodCycles,pcMinimumBaud:50*coreHz/periodCycles,estimatedBytes:(timestamps?9:5)*coreHz/periodCycles,wireBytes:baudRate/10};
}
export class SwoCapture {
  constructor(){this.serial=new SerialSession();this.probe=null;this.running=false;this.busy=false;this.saved=null;this.chunks=[];this.bytes=0;this.metadata={};this.onChange=()=>{};this.collecting=false;this._epoch=0;
    this.serial.on('data',b=>{this.lastRxAt=performance.now();if(!this.collecting)return;const room=MAX_RAW-this.bytes;if(room){const part=b.slice(0,room);this.chunks.push(part);this.bytes+=part.length;}if(b.length>room){this.metadata.limitReached=true;this.stop().catch(e=>this.onError?.(e));}});
    this.serial.on('error',e=>{if(this.collecting){(this.metadata.transportGaps??=[]).push({offset:this.bytes,reason:String(e.message).slice(0,240)});if(this.metadata.transportGaps.length>=100){this.metadata.errorLimitReached=true;this.stop().catch(error=>this.onError?.(error));}}this.onError?.(e);});
    this.serial.on('close',()=>{if(this.running&&!this._stopTask){this.metadata.disconnected=true;this.stop().catch(e=>this.onError?.(e));}});
  }
  get active(){return this.busy||this.running||!!this.probe||this.serial.isOpen;}
  createReceiver(){return new SwoReceiver();}
  async read(a){const b=await this.probe.readMemDiagnostic(a,4);return new DataView(b.buffer,b.byteOffset,4).getUint32(0,true);}
  async write(a,v){const b=new Uint8Array(4);new DataView(b.buffer).setUint32(0,v,true);await this.probe.writeMem(a,b);}
  async readClockConfig(){
    // Probe handoff can yield a stale peripheral read. Confirm the fixed RCC config
    // before deriving a core clock; unstable clocks must never enable trace.
    let previous=null,same=0;
    for(let i=0;i<6;i++){const value=await this.read(0x40021004);same=value===previous?same+1:1;previous=value;if(same===3)return value;}
    throw Error('RCC 时钟配置读回不稳定，请停止其他调试连接后重试');
  }
  async openProbe(){
    const devices=await WebUsbDapProbe.authorized();
    this.probe=devices.length===1?await WebUsbDapProbe.open(devices[0],{clockKhz:1000,skipClearHalt:true}):await WebUsbDapProbe.request(false,{clockKhz:1000,skipClearHalt:true});
  }
  async targetInfo(options={}){
    const cpuid=await this.read(0xe000ed00),device=await this.read(0xe0042000),cfgr=await this.readClockConfig(),cr=await this.read(0x40021000),dwt=await this.read(R.dwt);
    return stm32f1Info({cpuid,device,cfgr,cr,dwt,hseHz:options.hseHz??null,coreHz:options.coreHz,autoClock:!!options.autoClock});
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
  async verifiedTarget(options,alive){
    for(let attempt=1;attempt<=2;attempt++){
      const target=await this.identifyTarget(options,alive);
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
    const setup=async lease=>{try{await this.openProbe();lease?.assert();return await this.identifyTarget({...options,autoClock:false,coreHz:null},()=>lease?.assert());}finally{if(this.probe){await this.probe.disconnect();this.probe=null;}this.busy=false;this.onChange();}};
    this._startTask=this.probeManager?this.probeManager.run('swo',setup,{reason:'识别 SWO 目标',recovery:true}):setup();
    try{return await this._startTask;}finally{this._startTask=null;this.busy=false;this.onChange();}
  }
  async start(options){
    if(this.active||this._startTask||this._stopTask)throw Error('采样连接正在使用或切换中');
    this._onTarget=options.onTarget;let plan;if(!options.autoClock&&!options.targetClockHz&&!options.autoBaud)plan=tracePlan(options);if(!options.port)throw Error('请先选择 VCOM 串口');
    const token=++this._epoch;this.busy=true;this._startTime=null;this.onChange();
    const setup=async lease=>{const alive=()=>{lease?.assert();if(token!==this._epoch)throw Error('记录启动已取消');};
      try{
        alive();await this.openProbe();alive();
        let target=await this.verifiedTarget(options,alive);
        if(options.targetClockHz){
          if(!options.verifyElf)throw Error('目标调频必须先校验匹配 ELF');
          this.targetClock=new TargetClock(this,options.elf);await this.targetClock.validate();
          await this.targetClock.change(options.targetClockHz);alive();target=await this.identifyTarget({...options,autoClock:true},alive);
        }
        const desired={...options,coreHz:options.autoClock||options.targetClockHz?target.coreHz:options.coreHz};
        let matched=desired;
        if(options.receiverMode!==undefined){this.receiver=this.createReceiver();await this.receiver.open(this.probe.device?.serialNumber);alive();this.receiverSources=await this.receiver.sources();matched=matchedOptions(desired,this.receiverSources.frequencies);}
        plan=tracePlan(matched);
        if(await this.probe.isHalted())throw Error('目标处于暂停状态，请先继续运行再记录');
        this.clockCheck={cfgr:target.cfgr,knownHz:target.knownHz};
        options.onTarget?.(target);
        const saved={};for(const [name,addr] of Object.entries(R))saved[name]=await this.read(addr);
        this.wasLocked=!!((await this.read(0xe0000fb4))&2);this.saved=saved;
        await this.write(R.demcr,this.saved.demcr|0x01000000);await this.write(0xe0000fb0,0xc5acce55);
        await this.write(R.dwt,this.saved.dwt&~((1<<12)|(1<<16)));await this.write(R.itm,0);
        await this.write(R.dbg,(this.saved.dbg&~0xc0)|32);await this.write(R.acpr,plan.acpr);await this.write(R.sppr,2);await this.write(R.ffcr,0x100);
        await this.write(R.ter,plan.itm?0xffffffff:0);await this.write(R.tpr,0);
        // Receiver opens after the pin is quiet, and drains old UART bytes before enabling ITM.
        let receiverStatus=null;
        if(this.receiver){receiverStatus=await this.receiver.prepare(plan.baudRate,options.receiverMode);alive();
          if(Math.abs(receiverStatus.actualBaud-plan.baudRate)/plan.baudRate>.005)throw Error('目标与探针波特率偏差超过 0.5%');
          this.receiverPulse=setInterval(()=>{if(this._heartbeatTask)return;this._heartbeatTask=this.receiver.heartbeat().then(s=>{if(s.actualBaud!==receiverStatus.actualBaud||s.uartHz!==receiverStatus.uartHz)throw Error('探针时钟意外改变');}).catch(e=>{this.metadata.receiverError=e.message;this.onError?.(e);this.stop().catch(error=>this.onError?.(error));}).finally(()=>{this._heartbeatTask=null;});},1000);
        }
        await this.serial.open(options.port,{baudRate:this.receiver?Math.round(plan.baudRate):plan.requestedBaudRate,owner:'swo'});alive();this.lastRxAt=performance.now();for(let i=0;i<20;i++){await new Promise(r=>setTimeout(r,30));alive();if(performance.now()-this.lastRxAt>=150)break;if(i===19)throw Error('SWO 引脚关闭后接收仍未安静，请检查其他 trace 连接');}
        if(this.receiver){const actual=await this.receiver.heartbeat();if(actual.actualBaud!==receiverStatus.actualBaud||actual.uartHz!==receiverStatus.uartHz)throw Error('串口打开后探针配置改变');const d=await this.receiver.hid.xfer(0x18),v=new DataView(d.buffer,d.byteOffset+2);if(v.getUint32(24,true)||v.getUint32(12,true)!==actual.actualBaud||v.getUint32(16,true)!==actual.osr)throw Error('UART 线路配置回读失败');}
        const receiverBaseline=this.receiver?await this.receiver.diagnostics():null;
        this.chunks=[];this.bytes=0;this.metadata={receiverBaseline,format:'swo-pc-v1',startAligned:true,plan,startedAt:new Date().toISOString(),clockCheck:this.clockCheck,receiver:receiverStatus,receiverSources:this.receiverSources||null,targetClockOriginalHz:this.targetClock?.originalHz??null,target:{...target,probe:this.probe.device?.serialNumber||''},elfSha256:options.elfSha256||null,transportGaps:[]};
        this.collecting=true;
        const mask=0x007f1fff;await this.write(R.itm,plan.timestamps?0x1000f:0x1000d);await this.write(R.dwt,(this.saved.dwt&~mask)|1|(plan.post<<1)|(plan.post<<5)|(plan.tap<<9)|(1<<10)|(1<<12)|(plan.exceptions?(1<<16):0));
        alive();
        this.metadata.configReadback={dwt:await this.read(R.dwt),itm:await this.read(R.itm),acpr:await this.read(R.acpr),sppr:await this.read(R.sppr),dbg:await this.read(R.dbg)};
        const cfg=this.metadata.configReadback,expected=1|(plan.post<<5)|(plan.tap<<9)|(1<<10)|(1<<12)|(plan.exceptions?(1<<16):0);
        if(cfg.acpr!==plan.acpr||cfg.sppr!==2||(cfg.itm&0x1000f)!==(plan.timestamps?0x1000f:0x1000d)||(cfg.dwt&0x11fe1)!==expected||(cfg.dbg&0xe0)!==0x20)throw Error('SWO 配置回读失败');
        this.running=true;this._startTime=performance.now();this.timer=setTimeout(()=>this.stop().catch(e=>this.onError?.(e)),plan.seconds*1000);this.pulse=setInterval(()=>this.onChange(),200);
      }catch(error){try{await this._close();}catch(cleanup){this.probeManager?.fail('swo',cleanup);throw new AggregateError([error,cleanup],'启动失败且 trace 配置未确认恢复');}throw error;}
      finally{this.busy=false;this.onChange();}
    };
    this._startTask=this.probeManager?this.probeManager.run('swo',setup,{reason:'SWO 记录需要 SWD 与 VCOM',recovery:true}):setup();
    try{return await this._startTask;}finally{this._startTask=null;}
  }
  async _close(){
    clearTimeout(this.timer);clearInterval(this.pulse);clearInterval(this.receiverPulse);if(this._heartbeatTask)await this._heartbeatTask;let errors=[];
    if(this.probe&&this.saved){
      try{
        await this.write(R.ter,0);await this.write(R.dwt,this.saved.dwt&~((1<<12)|(1<<16)));
        // Drain valid queued packets while NRZ remains enabled. Disabling ITM
        // first can change the SWO idle level and create UART break bytes.
        this.lastRxAt=performance.now();for(let i=0;i<10;i++){await new Promise(r=>setTimeout(r,20));if(performance.now()-this.lastRxAt>=60)break;if(i===9)this.metadata.endAligned=false;}
        if(this.receiver&&this.metadata.receiverBaseline){const current=await this.receiver.diagnostics();this.metadata.receiverDiagnostics=current;this.metadata.receiverErrors=Object.fromEntries(Object.entries(current).map(([k,v])=>[k,(v-this.metadata.receiverBaseline[k])>>>0]));}
        this.collecting=false;await this.write(R.itm,0);
      }catch(e){errors.push(e);}
      this.collecting=false;
      // Restore producers last; a counter that was running is never rewound.
      for(const name of ['acpr','sppr','ffcr','ter','tpr','dbg','dwt','itm','demcr'])try{await this.write(R[name],this.saved[name]);}catch(e){errors.push(e);}
      if(!(this.saved.dwt&1))try{await this.write(R.cyccnt,this.saved.cyccnt);}catch(e){errors.push(e);}
      for(const name of ['acpr','sppr','ffcr','ter','tpr','dbg','dwt','itm','demcr'])try{const mask=name==='dwt'?~0x1e:name==='ffcr'?~0x40:name==='itm'?~0x800000:-1;if(((await this.read(R[name]))&mask)!==(this.saved[name]&mask))throw Error(name+' 恢复回读不一致');}catch(e){errors.push(e);}
      if(this.wasLocked)try{await this.write(0xe0000fb0,0);}catch(e){errors.push(e);}
    }
    this.collecting=false;this.running=false;
    try{await this.serial.close();}catch(e){errors.push(e);}
    if(this.receiver)try{await this.receiver.close();this.receiver=null;this.metadata.receiverRestored=true;}catch(e){errors.push(e);}
    if(this.targetClock)try{const originalHz=this.targetClock.originalHz;await this.targetClock.restore();const target=await this.targetInfo({autoClock:true,hseHz:8000000});if(target.coreHz!==originalHz&&originalHz)throw Error('目标主频恢复回读失败');this._onTarget?.(target);this.targetClock=null;this.metadata.targetClockRestored=true;}catch(e){errors.push(e);}
    if(errors.length){this.metadata.restoreError=errors.map(e=>e.message).join('; ');throw new AggregateError(errors,'Trace 配置恢复失败，快照已保留；请检查连接并重试停止');}
    if(this.probe){await this.probe.disconnect();this.probe=null;}
    this.saved=null;delete this.metadata.restoreError;this.metadata.restored=true;
  }
  async stop(){
    if(this._stopTask)return this._stopTask;
    this._epoch++;this.probeManager?.cancel('swo');
    this._stopTask=(async()=>{try{if(this._startTask)await this._startTask.catch(()=>{});if(this._startTime)this.metadata.elapsedMs=performance.now()-this._startTime;await this._close();this.probeManager?.forget('swo');}
      catch(e){this.probeManager?.fail('swo',e);throw e;}finally{this.onChange();}})();
    try{await this._stopTask;}finally{this._stopTask=null;}
  }
  raw(){const b=new Uint8Array(this.bytes);let p=0;for(const x of this.chunks){b.set(x,p);p+=x.length;}return b;}
}

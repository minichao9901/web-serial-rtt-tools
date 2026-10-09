import { AkaLinkHid } from '../hid/probe.js';
import { runProbeOperation } from '../core/probe-manager.js';
import { waitMs } from '../core/pace.js';
import { withTimeout } from '../rtt/dap-webusb.js';
import { DacClient } from './dac-protocol.js';
import { dacTable } from './model.js';
import { AdcTransport, ADC_MAX_INFLIGHT } from './transport.js';
import { ADC_ACT, decodeReply, streamCaps } from './adc-protocol.js';
import * as SPI from '../spi/protocol.js';
export { decodeReply, streamCaps } from './adc-protocol.js';
/** CAPS 复读次数有界；每轮间隔 20 ms，USB 退场另有独立超时。 */
const SHARED_RETIRE_ATTEMPTS = 12;
export class AnalogSession {
  constructor(){ this.hid = null; this.caps = null; this.dac = null; this.busy = false; this.usingMock = false; }
  get connected(){ return !!this.hid?.connected; }
  setBusy(value){ this.busy = value; this.onChange?.(); }
  async connect(){
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = runProbeOperation(this, 'analog', async lease => {
      const alive=()=>lease?.assert();alive();
      if(this._connectCleanupError)throw Error('上次 HID 连接清理未完成，请先断开重试');
      if (this.connected) return this.caps || {supported:false};
      const hid = new AkaLinkHid();
      try {
        await hid.request();
        alive();
        let caps;
        try{caps=streamCaps(decodeReply(await hid.xfer(0x38,Uint8Array.of(ADC_ACT.CAPS)),ADC_ACT.CAPS),{allowUnsupported:true});}
        catch(e){if(![1,4].includes(e.code))throw e;caps={supported:false};}
        const dac = new DacClient((cmd,data)=>hid.xfer(cmd,data));
        await dac.capabilities();
        alive();
        if(!caps.supported&&!dac.caps.supported)throw Error('当前固件没有可用的 ADC DMA 或 DAC 输出能力');
        this.caps = caps.supported?caps:null; this.hid = hid; this.dac = dac;
        hid.onDisconnect = () => { this._adcAbort?.abort(); this._dacStart?.controller.abort();  this.onDisconnect?.(); };
        return caps;
      } catch (e){
        try{await hid.close();}
        catch(cleanup){
          this.hid=hid;this._connectCleanupError=cleanup;
          const error=new AggregateError([e,cleanup],'模拟接口连接失败且 HID 清理未确认，请重试断开');
          this.probeManager?.fail('analog',error);throw error;
        }
        throw e;
      }
    }, { reason: 'ADC 页面要使用探针', recovery: true });
    this.onChange?.();
    try { return await this._connectPromise; } finally { this._connectPromise = null; this.onChange?.(); }
  }
  async acquire(options, onResult){
    if (this._adcRun) throw Error('ADC 已有采集在进行');
    const controller = new AbortController(); this._adcAbort = controller;
    const run = this._acquire(options, onResult, controller.signal);
    this._adcRun = run;
    try { return await run; }
    finally { this._adcRun = null; this._adcAbort = null; }
  }
  async _acquire({bits,rate,count=0},onBlock,signal){
    if(!this.connected)throw Error('先连接探针');
    if(this.busy)throw Error('ADC 已有采集在进行');
    if(!this.caps)throw Error('当前固件未提供 ADC DMA 能力');
    if(![8,10,12,16].includes(bits)||!Number.isInteger(rate)||rate<1||rate>this.caps.maxRate ||
       !Number.isInteger(count)||count<0||count>0xffffffff)throw Error('ADC 位宽、采样率或长度无效');
    this.setBusy(true);
    this._requestedBits=bits;
    const abort=()=>{this._sendStop().catch(e=>{this._adcStopError=e;});};
    try{
      if(!this.transport)this.transport=await AdcTransport.request(this.hid.device);
      await this._acquireSharedCaps({signal});
      await this.transport.retireSpiIn();
      if(signal.aborted)return;
      const requestedDepth=this.adcInFlight??32;
      if(!Number.isInteger(requestedDepth)||requestedDepth<1||requestedDepth>ADC_MAX_INFLIGHT)
        throw Error('ADC USB 接收深度必须为 1–32');
      let maxDepth=1;
      try{
        const p=await this.streamCommand(ADC_ACT.PIPELINE);
        if(p.length!==2||p[0]!==1||p[1]<1||p[1]>ADC_MAX_INFLIGHT)throw Error('ADC USB 流水线能力无效');
        maxDepth=p[1];
      }catch(e){if(![1,4].includes(e.code))throw e;} // Legacy firmware rejects this additive query.
      this._requestedInFlight=Math.min(requestedDepth,maxDepth);
      const args=new Uint8Array(this._requestedInFlight>1?10:9),v=new DataView(args.buffer);args[0]=bits;
      v.setUint32(1,rate,true);v.setUint32(5,count,true);
      if(args.length===10)args[9]=this._requestedInFlight;
      this._openUncertain=true;
      let b;
      try{b=await this.streamCommand(ADC_ACT.OPEN,args);}
      catch(e){if(e.code!=null)this._openUncertain=false;throw e;}
      if(b.length!==4)throw Error('ADC OPEN 应答长度错误');
      this._streamToken=new DataView(b.buffer,b.byteOffset,b.byteLength).getUint32(0,true);
      this._openUncertain=false;
      this._adcStopError=null;
      this.transport.start(this._streamToken,{bits,inFlight:this._requestedInFlight,onBlock,onFault:abort});
      signal.addEventListener('abort',abort,{once:true});
      if(signal.aborted)abort();else await this.streamCommand(ADC_ACT.START);
      await this.transport.pending;
      if(this.transport.error)throw this.transport.error;
      if(this._adcStopError)throw this._adcStopError;
    }finally{
      signal.removeEventListener('abort',abort);
      try{await this._cleanupAdc();this.setBusy(false);}
      catch(e){this._adcCleanupError=e;this.probeManager?.fail('analog',e);throw e;}
    }
  }
  async streamCommand(action,args=new Uint8Array()){
    return decodeReply(await this.hid.xfer(0x38,Uint8Array.of(action,...args)),action);
  }
  // CAPS is a retirement fence, not permission to erase native USB ownership.
  async _acquireSharedCaps({signal}={}){
    let retired=false;
    for(let attempt=0;attempt<SHARED_RETIRE_ATTEMPTS;attempt++){
      if(signal?.aborted)throw Error('ADC 启动已取消');
      const caps=streamCaps(await this.streamCommand(ADC_ACT.CAPS));
      if(!caps.flags)return caps;
      if((caps.flags&2)&&!retired){
        await this._retireSharedBuffers();retired=true;
      }
      if(caps.flags&1)await this.transport.retireSpiOut();
      await waitMs(20);
    }
    throw Error('SPI/QSPI 仍占着共享缓冲（USB 退场未确认）：请停止 SPI/QSPI 后重试');
  }
  async _retireSharedBuffers(){
    // Close an abandoned ADC owner before sending SPI control commands: SPI
    // correctly rejects them while ADC owns the endpoint. Only BUSY is retryable.
    const status=await this.streamCommand(ADC_ACT.STATUS);
    if(status.length!==24)throw Error('ADC 状态应答长度错误');
    if(status[20]){
      await this.streamCommand(ADC_ACT.END);
      await this.transport.retireSpiIn();
      let closed=false;
      for(let attempt=0;attempt<SHARED_RETIRE_ATTEMPTS;attempt++){
        try{await this.streamCommand(ADC_ACT.CLOSE);closed=true;break;}
        catch(e){if(e.code!==2)throw e;await waitMs(20);}
      }
      if(!closed)throw Error('上一轮 ADC 会话退场未确认');
    }
    for(const data of [SPI.hidData.enable(false),SPI.hidData.abort()]){
      const reply=await this.hid.xfer(SPI.HID_CMD,data);
      if(!(reply instanceof Uint8Array)||reply.length<7||reply[0]<8||
         reply[1]!==SPI.HID_CMD||reply[2]!==data[0])throw Error('SPI 退场应答无效');
      const state=SPI.statusWord(SPI.parseWordPayload(reply));
      // err is the last frame error, not a per-command return code. Fresh CAPS
      // below confirms retirement; do not reject a successful disable for it.
      if(state.enabled)throw Error('SPI 失能未确认');
    }
    await this.transport.retireSpiIn();
  }
  async _sendStop(){
    if(this._streamToken==null)return;
    // Coalesce a live STOP, but permit retries after an error/timeout.
    if(this._stopCommand)return this._stopCommand;
    this._stopCommand=this.streamCommand(ADC_ACT.END);
    try{await this._stopCommand;}finally{this._stopCommand=null;}
  }
  async _cleanupAdc(){
    // A timed-out OUT is still owned by native USB. Do not clear busy/retry it.
    if(this.transport?.flush)await withTimeout(this.transport.flush,2000,'等待 SPI OUT 退场');
    if(this._openUncertain){
      const b=await this.streamCommand(ADC_ACT.STATUS);
      if(b.length!==24)throw Error('ADC 状态应答长度错误');
      if(b[20]){
        this._streamToken=new DataView(b.buffer,b.byteOffset,b.byteLength).getUint32(0,true);
        this.transport.start(this._streamToken,{bits:this._requestedBits,inFlight:this._requestedInFlight});
      }
      this._openUncertain=false;
    }
    if(this._streamToken==null)return;
    if(this.transport?.lease?.entry?.disconnected){
      if(this.transport.pending)await withTimeout(this.transport.pending,3000,'等待拔出 USB 请求退场');
      this._streamToken=null;return;
    }
    await this._sendStop();await this.transport.drain();
    const deadline=performance.now()+3000;
    for(;;){
      try{await this.streamCommand(ADC_ACT.CLOSE);break;}
      catch(e){if(e.code!==2||performance.now()>=deadline)throw e;await waitMs(5);}
    }
    this._streamToken=null;this._adcCleanupError=null;
  }
  async startDac(options){
    if(!this.connected)throw Error('先连接探针');
    if(this.busy)throw Error('先停止当前 ADC/DAC 任务');
    if(!this.dac)throw Error('当前固件未支持 DAC');
    this.dac.requireChannel(options.channel);
    const table=dacTable(options,this.dac.caps),dac=this.dac;
    this.setBusy(true);
    const controller=new AbortController();
    const promise=dac.startLut({channel:options.channel,bits:dac.caps.bits,rate:options.rate,idleCode:0},table.codes,{signal:controller.signal});
    this._dacStart={controller,promise};
    try {
      const result=await promise;
      return {...result,actualFrequency:table.actualFrequency===null?null:result.actualRate/result.points};
    } catch(e){
      if(!dac.owned)this.setBusy(false);
      else this.probeManager?.fail('analog',e);
      throw e;
    } finally {this._dacStart=null;}
  }
  async stopDac(){
    if(this._dacStart){
      const start=this._dacStart;start.controller.abort();
      await start.promise.catch(()=>{}); // Drain START before STOP: no late start after stop.
    }
    if(!this.dac?.owned)return;
    try {await this.dac.stop();this.setBusy(false);this.probeManager?.confirm('analog');}
    catch(e){this.probeManager?.fail('analog',e);throw e;}
  }
  async dacStatus(channel=this.dac?.channel ?? 0){
    if(!this.dac)throw Error('先连接探针');
    const s=await this.dac.status(channel);
    if(this.dac.owned && s.token!==this.dac.token)throw Error('DAC 状态任务代数不匹配');
    if(!this._dacStart && this.dac.owned && !s.running && !s.cleanup){this.dac.owned=false;this.setBusy(false);this.probeManager?.confirm('analog');}
    return s;
  }
  async stopAdc(){
    if(this._dacStart||this.dac?.owned)throw Error('DAC 仍占用会话，请使用输出 OFF');
    this._adcAbort?.abort();
    try{
      await this._sendStop();
      if(this._adcRun)await withTimeout(this._adcRun.catch(e=>{if(this.busy)throw e;}),4000,'等待 ADC 停止');
      if(this._adcCleanupError||this._streamToken!=null||this._openUncertain)await this._cleanupAdc();
      this._adcCleanupError=null;this.setBusy(false);this.probeManager?.confirm('analog');
    }catch(e){this.probeManager?.fail('analog',e);throw e;}
  }
  async stop(){ await this.stopDac(); await this.stopAdc(); }
  async disconnect(){
    this.probeManager?.cancel('analog');
    this._disconnecting = true; this.onChange?.();
    try {
      if (this._connectPromise) await this._connectPromise.catch(() => {});
      await this.stop(); await this.transport?.close(); this.transport = null;
      await this.hid?.close(); this.hid = null; this.caps = null; this.dac = null;
      this._connectCleanupError=null;
      this.probeManager?.forget('analog');
    } catch (e){ this.probeManager?.fail('analog', e); throw e; }
    finally { this._disconnecting = false; this.onChange?.(); }
  }
}

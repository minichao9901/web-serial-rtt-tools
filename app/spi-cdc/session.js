import {AkaLinkHid} from '../hid/probe.js';
import {runProbeOperation} from '../core/probe-manager.js';
import {waitMs} from '../core/pace.js';
import {CMD,ACT,startData,decodeReply,resultText} from './protocol.js';
export class SpiCdcSession {
  constructor({hidFactory=()=>new AkaLinkHid(),wait=waitMs}={}){
    this.hidFactory=hidFactory;this.wait=wait;this.hid=null;this.last=null;this.busy=false;
  }
  get connected(){return !!this.hid?.connected;}
  get running(){return !!(this.last?.running||this._requested);}
  async connect(interactive=true){
    if(this._connectPromise)return this._connectPromise;
    if(this.busy)throw Error('正在处理 SPI转发 启停');
    this.busy=true;this.onChange?.();
    this._connectPromise=runProbeOperation(this,'spicdc',async lease=>{
      if(this.connected)return this.status();
      const hid=this.hidFactory();
      try {
        if(interactive)await hid.request();else await hid.reconnect();
        lease?.assert();
        const status=decodeReply(await hid.xfer(CMD,Uint8Array.of(ACT.STATUS)));
        if(!status.supported)throw Error(resultText(-1));
        lease?.assert();this.hid=hid;this.last=status;
        hid.onDisconnect=()=>{this._requested=false;this.last=null;this.onChange?.();};
        this.probeManager?.confirm('spicdc');this.onChange?.();return status;
      }catch(error){
        try{await hid.close();}catch(cleanup){this.hid=hid;this.probeManager?.fail('spicdc',cleanup);throw cleanup;}
        throw error;
      }
    },{reason:'SPI转发 要使用共享 SPI 缓冲和 CDC 数据源',recovery:true});
    try{return await this._connectPromise;}finally{this._connectPromise=null;this.busy=false;this.onChange?.();}
  }
  async command(action,data=Uint8Array.of(action)){
    if(!this.connected)throw Error('先连接探针');
    this.last=decodeReply(await this.hid.xfer(CMD,data),action);this.onChange?.();return this.last;
  }
  status(){return this.command(ACT.STATUS);}
  async settled(generation){
    for(let i=0;i<100;i++){
      const s=await this.status();
      if(generation!==undefined&&s.generation!==generation)throw Error('SPI转发 请求被另一会话替换');
      if(!s.pending&&s.rc!==-100)return s;
      await this.wait(20);
    }
    throw Error('SPI转发 启停超时，请重连并停止');
  }
  async start(config){
    const data=startData(config);
    if(this.busy)throw Error('正在处理 SPI转发 启停');
    if(!this.connected)throw Error('先连接探针');
    this.busy=true;this.onChange?.();
    this._startPromise=(async()=>{try{
      return await runProbeOperation(this,'spicdc',async lease=>{
        await this.probeManager?.cdcMode?.drainWrites();
        lease?.assert();
        this._requested=true;
        const accepted=await this.command(ACT.START,data);
        const s=await this.settled(accepted.generation);
        if(s.rc!==0||!s.running){this._requested=false;throw Error(resultText(s.rc));}
        lease?.assert();
        this.probeManager?.confirm('spicdc');
        return s;
      },{reason:'SPI 从机转发要使用 SPI 缓冲和 CDC',recovery:true});
    }catch(error){if(this._requested)this.probeManager?.fail('spicdc',error);throw error;}
    finally{this.busy=false;this.onChange?.();}
    })();
    try{return await this._startPromise;}finally{this._startPromise=null;}
  }
  async stop(){
    if(this._stopPromise)return this._stopPromise;
    this.probeManager?.cancel('spicdc');
    this._stopPromise=(async()=>{
    if(this._startPromise)await this._startPromise.catch(()=>{});
    if(!this.connected){if(this._requested)throw Error('SPI转发 停止尚未确认，请先重连探针');return;}
    this.busy=true;this.onChange?.();
    try{
      const accepted=await this.command(ACT.STOP);const s=await this.settled(accepted.generation);
      if(s.running||s.rc!==0)throw Error(resultText(s.rc));
      this._requested=false;this.probeManager?.confirm('spicdc');return s;
    }catch(error){this.probeManager?.fail('spicdc',error);throw error;}
    finally{this.busy=false;this.onChange?.();}
    })();
    try{return await this._stopPromise;}finally{this._stopPromise=null;}
  }
  async disconnect(){
    this.probeManager?.cancel('spicdc');
    if(this._connectPromise)await this._connectPromise.catch(()=>{});
    await this.stop();
    try{if(this.hid)await this.hid.close();}
    catch(error){this.probeManager?.fail('spicdc',error);throw error;}
    this.hid=null;this.last=null;this.probeManager?.forget('spicdc');this.onChange?.();
  }
}

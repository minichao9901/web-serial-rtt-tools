import {WebUsbDapProbe} from '../rtt/dap-webusb.js';
import {store} from '../core/store.js';

export function workbenchUrl(current=location,saved=store.get('gen.etmPort',8878)){
  const local=['127.0.0.1','localhost','[::1]'].includes(current.hostname),port=Number(local&&current.port?current.port:saved);
  return `http://127.0.0.1:${Number.isInteger(port)&&port>=1024&&port<=65535?port:8878}/#etm`;
}

/** Same-origin embedded ETM; the parent owns probe arbitration and USB leases. */
export class EtmView {
  constructor(){this.bridge=null;this.loading=null;this.started=false;this.probeType=WebUsbDapProbe;}
  get probe(){return this.bridge?.probe()||null;}
  get busy(){return !!this.bridge?.busy();}
  init(){
    this.frame=document.getElementById('etm-frame');this.notice=document.getElementById('etm-notice');
    document.getElementById('etm-retry').onclick=()=>this.retry();
    window.addEventListener('pagehide',()=>{if(this.bridge)this.childUnloaded(this.bridge);});
    const open=document.getElementById('etm-open');open.href=workbenchUrl();open.onclick=()=>{open.href=workbenchUrl();};
    this.frame.addEventListener('load',()=>{
      if(!this.started)return;
      if(!this.childReady())this.showError('ETM 页面未就绪；请点击重新检测。旧连接会先安全释放');
    });
  }
  async onShow(){
    const open=document.getElementById('etm-open');if(open)open.href=workbenchUrl();
    if(this.bridge){if(!this.childReady())this.showError('ETM 子页面已失联；请点击重新检测，先释放旧连接');return;}
    if(this.loading)return this.loading;
    this.loading=this.load().finally(()=>this.loading=null);return this.loading;
  }
  async load(){
    const status=document.getElementById('etm-status');status.textContent='正在检测本地 ETM 服务…';
    try{
      const controller=new AbortController();let timer,info;
      try{info=await Promise.race([
        fetch('/etm/integration.json',{cache:'no-store',signal:controller.signal}).then(async response=>{if(!response.ok)throw Error('请启动本地 ETM 工作台后打开本页');return response.json();}),
        new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('检测本地桥超时，请确认桥已启动后重试'));},15000);})
      ]);}finally{clearTimeout(timer);}
      if(info.protocol!==1)throw Error('本地 ETM 集成服务版本不匹配');
      this.started=true;this.frame.hidden=false;this.frame.src='/etm/?embedded=1';
      status.textContent='正在载入 ETM 执行轨迹…';
    }catch(e){this.notice.hidden=false;this.frame.hidden=true;status.textContent=e.message;}
  }
  attach(bridge,child){
    if(child!==this.frame.contentWindow||child.location.origin!==location.origin)
      throw Error('ETM 页面来源不匹配');
    if(this.bridge&&this.probe){this.showError('旧 ETM 页面仍连接探针；点击重新检测会先停止旧任务并释放连接');throw Error('请先释放原 ETM 探针再重新载入页面');}
    this.bridge=bridge;this.notice.hidden=true;
    child.addEventListener('pagehide',()=>this.childUnloaded(bridge),{once:true});
    return this;
  }
  childReady(){try{return !!this.bridge&&this.frame.contentWindow.__etmBridge===this.bridge;}catch{return false;}}
  async childUnloaded(bridge){
    if(this.bridge!==bridge)return;
    if(this.detaching){await this.detaching.catch(()=>{});if(this.bridge!==bridge)return;}
    this.showError('ETM 子页面已卸载，正在停止旧任务并释放连接…');
    this.detaching=(async()=>{
      if(bridge.busy())await bridge.requestStop();
      const release=()=>this.releaseProbe(bridge);
      if(this.probeManager)await this.run(release);else await release();
      if(this.bridge===bridge){this.bridge=null;this.showError('旧 ETM 连接已释放，请点击重新检测服务');}
    })();
    try{await this.detaching;}catch(e){this.showError('旧页面卸载后的清理未完成：'+e.message+'；保留连接信息，请重新检测或恢复原调试口');}
    finally{this.detaching=null;}
  }
  showError(message){this.notice.hidden=false;document.getElementById('etm-status').textContent=message;}
  async retry(){
    try{
      if(this.detaching)await this.detaching;
      if(this.bridge){
        if(this.busy&&this.bridge.requestStop)await this.bridge.requestStop();
        const release=async()=>{
          // Explicit retry can recover a faulted old realm whose controls no
          // longer exist. Recovery restores trace state and leaves CPU halted.
          if(!this.childReady()&&this.bridge.summary?.()?.transportFault&&this.bridge.recoverForRelease)await this.bridge.recoverForRelease();
          await this.releaseProbe();this.bridge=null;
        };
        if(this.probeManager)await this.probeManager.run('etm',release,{recovery:true,reason:'重新检测并释放旧 ETM 连接'});else await release();
      }
      this.started=false;return this.onShow();
    }catch(e){this.showError(e.message);}
  }
  run(fn){return this.probeManager.run('etm',fn,{reason:'ETM 执行轨迹使用探针'});}
  async releaseProbe(bridge=this.bridge){
    if(bridge?.busy())throw Error('ETM 正在操作目标或采集，请先停止采集');
    if(bridge)await bridge.release();
    if(bridge?.probe())throw Error('ETM 探针仍未确认断开，请保留当前页面并重试');
    if(this.bridge===bridge)this.probeManager?.forget('etm');
  }
  summary(){return {ready:!!this.bridge,connected:!!this.probe,busy:this.busy,...this.bridge?.summary()};}
}

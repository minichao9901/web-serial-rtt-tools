import {WebUsbDapProbe} from '../rtt/dap-webusb.js';

/** Same-origin embedded ETM; the parent owns probe arbitration and USB leases. */
export class EtmView {
  constructor(){this.bridge=null;this.loading=null;this.started=false;this.probeType=WebUsbDapProbe;}
  get probe(){return this.bridge?.probe()||null;}
  get busy(){return !!this.bridge?.busy();}
  init(){
    this.frame=document.getElementById('etm-frame');this.notice=document.getElementById('etm-notice');
    document.getElementById('etm-retry').onclick=()=>this.retry();
    this.frame.addEventListener('load',()=>{
      if(!this.started)return;
      if(!this.bridge||this.frame.contentWindow.__etmBridge!==this.bridge)this.showError('ETM 页面未就绪；请点击重新检测。旧连接会先安全释放');
    });
  }
  async onShow(){
    if(this.bridge)return;
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
    return this;
  }
  showError(message){this.notice.hidden=false;document.getElementById('etm-status').textContent=message;}
  async retry(){
    try{
      if(this.bridge){
        if(this.busy&&this.bridge.requestStop)await this.bridge.requestStop();
        await this.releaseProbe();this.bridge=null;
      }
      this.started=false;return this.onShow();
    }catch(e){this.showError(e.message);}
  }
  run(fn){return this.probeManager.run('etm',fn,{reason:'ETM 执行轨迹使用探针'});}
  async releaseProbe(){
    if(this.busy)throw Error('ETM 正在操作目标或采集，请先停止采集');
    if(this.bridge)await this.bridge.release();
  }
  summary(){return {ready:!!this.bridge,connected:!!this.probe,busy:this.busy,...this.bridge?.summary()};}
}

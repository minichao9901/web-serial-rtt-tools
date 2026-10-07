import {$,setStatus} from '../ui/dom.js';
import {store} from '../core/store.js';
import {bytes as fBytes} from '../core/format.js';
import {RttCdcStreamView} from '../hid/stream.js';
import {SpiCdcSession} from './session.js';
import {resultText} from './protocol.js';
export class SpiCdcView {
  constructor(serial){
    this.session=new SpiCdcSession();
    this.stream=new RttCdcStreamView(serial,{prefix:'si-rx',tab:'spicdc',namespace:'spicdc',group:'sirxmode',owner:'spi-cdc'});
  }
  init(){
    this.stream.init();
    for(const id of ['mode','lsb'])store.bind($('si-'+id),'spicdc.'+id);
    this.session.onChange=()=>this.render();
    const bind=(id,fn)=>$('si-'+id).addEventListener('click',async()=>{
      try{await fn();setStatus($('si-info'),this.session.connected?this.session.hid.label:'未连接',null);}
      catch(error){setStatus($('si-info'),error.message,'err');}
      this.render();
    });
    bind('connect',()=>this.session.connect());bind('reconnect',()=>this.session.connect(false));
    bind('disconnect',()=>this.session.disconnect());
    bind('start',()=>this.session.start({mode:Number($('si-mode').value),lsb:$('si-lsb').value==='1'}));
    bind('stop',()=>this.session.stop());bind('status',()=>this.session.status());
    setInterval(()=>{if(this.session.connected&&!this.session.busy)this.session.status().catch(e=>setStatus($('si-info'),e.message,'err'));},1000);
    this.render();
  }
  onShow(){this.stream.onShow();this.render();}
  render(){
    const s=this.session.last,connected=this.session.connected,busy=this.session.busy;
    for(const id of ['connect','reconnect'])$('si-'+id).disabled=connected||busy;
    $('si-disconnect').disabled=!connected||busy;
    $('si-start').disabled=!connected||busy||!!s?.running;
    $('si-stop').disabled=!connected||busy;
    $('si-status').disabled=!connected||busy;
    for(const id of ['mode','lsb'])$('si-'+id).disabled=busy||!!s?.running;
    $('si-state').textContent=s?`${s.running?'运行中':s.pending?'处理中':'已停止'} · ${resultText(s.rc)}\nSPI 接收 ${fBytes(s.received)} · 转入 CDC ${fBytes(s.forwarded)}\n丢弃 ${fBytes(s.dropped)} · FIFO 溢出 ${s.fifoOverflows} · DMA 错误 ${s.dmaErrors}\n循环缓冲 ${fBytes(s.bufferBytes)} · 待转发 ${fBytes(s.pendingBytes)} · CDC 待发送 ${fBytes(s.cdcQueued)}`:'等待连接探针';
  }
}

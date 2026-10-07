import { $ } from '../ui/dom.js';
import { AnalogSession } from './session.js';
import { WAVES, dacTable, signalLevels, waveCsv } from './model.js';
import { AdcScopeStore, envelope } from './scope-store.js';
import { measureAdc, cursorDelta, formatMeasure } from './measure.js';
import { PinMap } from '../ui/pin-map.js';
export class AnalogView {
  constructor(){ this.session = new AnalogSession(); this.store = new AdcScopeStore(); this.wave = []; this._raf = null; this.total = 0; this.page='adc'; this.canvasSizes = new Map(); this.adcCursors={x:null,y:null}; }
  init(){
    this.initTabs();
    this.canvasFont = `13px ${getComputedStyle(document.documentElement).getPropertyValue('--mono').trim()}`;
    this.resizeObserver = new ResizeObserver(entries => {
      for (const { target, contentRect } of entries){
        if (contentRect.width < 1 || contentRect.height < 1) continue;
        this.canvasSizes.set(target.id, { w:contentRect.width, h:contentRect.height });
      }
      this.renderAdc();
      if (this.page === 'dac') try { this.preview(); } catch (e){ $('an-wave-state').textContent = e.message; }
    });
    for (const id of ['an-adc-canvas','an-dac-canvas']) this.resizeObserver.observe($(id));
    this.pinMap=new PinMap({buttonId:'an-pinmap-btn',feature:'adc',state:()=>({connected:this.session.connected,connectionKey:this.session.hid?.device||this.session.hid,supported:!!this.session.caps})});
    this.pinMap.init();
    const bind = (id, fn) => $(id).addEventListener('click', () => { Promise.resolve().then(fn).catch(e => this.status(e.message, true)); });
    bind('an-connect', async () => {
      const c = await this.session.connect(); if (!c) return;
      $('an-channel').textContent=c.supported?'CH1 · PB14 / ADC0.6 · EVKLite J3[10]（与 QSPI IO2 互斥）':'当前固件未提供 ADC DMA；DAC 可独立使用';
      if(c.supported){$('an-rate').max=c.maxRate;$('an-reference').value=c.reference;}
      this.updateDacControls();
      try{this.preview();}catch(e){$('an-wave-state').textContent=e.message;}
      this.status(c.supported?(this.session.dac.caps.supported?'ADC/DAC 已连接':'ADC 已连接；当前固件未支持 DAC'):'DAC 信号发生器已连接');
    });
    bind('an-disconnect', async () => { await this.session.disconnect(); this.updateDacControls(); this.status('ADC 已断开'); });
    bind('an-once', () => this.acquire(Math.max(32,Math.min(65536,Math.round(Number($('an-rate').value)*10*Number($('an-time').value)))))); bind('an-start', () => this.acquire(Number($('an-count').value)));
    bind('an-stop', async () => { await this.session.stopAdc(); this.status('已确认 ADC 停止'); });
    bind('an-adc-export', () => this.download('adc.csv', this.store.csv(Number($('an-reference').value))));
    bind('an-wave-export', () => { this.preview(); this.download('waveform-preview.csv', waveCsv(this.wave)); });
    bind('an-preview', () => this.preview());
    bind('an-dac-start', async () => {
      this.preview();
      const options=this.waveOptions(); options.channel=Number($('an-dac-channel').value);
      const r=await this.session.startDac(options);
      $('an-dac-state').textContent=`DAC 已启动：${r.actualRate} Sa/s，${r.points} 点${r.actualFrequency===null?'':`，实际 ${r.actualFrequency.toFixed(4)} Hz`}`;
    });
    bind('an-dac-stop', async () => {if(!this.session.dac?.owned&&!this.session._dacStart)throw Error('本会话没有 DAC 输出任务，请先查询输出状态');await this.session.stopDac();$('an-dac-state').textContent='DAC 已确认停止';});
    bind('an-dac-status', async () => {const s=await this.session.dacStatus(Number($('an-dac-channel').value));$('an-dac-state').textContent=`DAC ${s.running?'运行':'停止'} · 已完成 ${s.cycles} 周期 · ${s.actualRate} Sa/s`;});
    $('an-wave').innerHTML = Object.entries(WAVES).map(([key, label]) => `<option value="${key}">${label}</option>`).join('');
    for (const id of ['an-wave', 'an-update', 'an-frequency', 'an-amplitude', 'an-vpp', 'an-min', 'an-max', 'an-dac-offset', 'an-dac-reference', 'an-duty', 'an-phase', 'an-points', 'an-dac-bits']) $(id).addEventListener('change', () => {
      try { this.syncLevels(['an-min','an-max'].includes(id)?'range':id==='an-vpp'?'vpp':'amplitude');this.preview(); }
      catch (e){ this.wave = []; this.plot('an-dac-canvas', []); $('an-generator-summary').textContent='设置无效';$('an-wave-state').textContent = e.message; }
    });
    this.session.onDisconnect = () => {this.updateDacControls();this.status('探针已掉线；采集已请求取消', true);};
    for(const id of ['an-time','an-volts','an-offset','an-trigger','an-level','an-edge','an-freeze','an-reference'])$(id).addEventListener('change',()=>this.renderAdc());
    this.initAdcCursors();
    this.updateDacControls(); this.preview(); this.renderAdc();
  }
  initTabs(){
    const tabs=[...document.querySelectorAll('#an-dock-tabs [data-an-tab]')];
    for(const tab of tabs){
      tab.addEventListener('click',()=>this.selectTab(tab.dataset.anTab));
      tab.addEventListener('keydown',event=>{
        if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
        event.preventDefault();
        const current=tabs.indexOf(tab),next=event.key==='Home'?0:event.key==='End'?tabs.length-1:
          (current+(event.key==='ArrowRight'?1:tabs.length-1))%tabs.length;
        this.selectTab(tabs[next].dataset.anTab,{focus:true});
      });
    }
    this.selectTab(this.page);
  }
  selectTab(name,{focus=false}={}){
    if(!['adc','dac'].includes(name))return;
    this.page=name;
    for(const tab of document.querySelectorAll('#an-dock-tabs [data-an-tab]')){
      const active=tab.dataset.anTab===name;
      tab.classList.toggle('on',active);tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;
      if(active&&focus)tab.focus();
    }
    for(const panel of document.querySelectorAll('#tab-analog [data-an-page]')){
      const active=panel.dataset.anPage===name;
      panel.classList.toggle('on',active);panel.hidden=!active;
    }
    if(name==='adc')this.renderAdc();
    else if(this.wave.length===0)this.preview();
  }
  status(text, error = false){ $('an-state').textContent = text; $('an-state').style.color = error ? '#f85149' : '';this.pinMap?.refresh(); }
  async acquire(count){
    if(this.session.busy)throw Error('先停止当前采集');
    const options={bits:Number($('an-bits').value),rate:Number($('an-rate').value),count};
    const reference=Number($('an-reference').value);
    if(!Number.isFinite(reference)||reference<=0||reference>10)throw Error('参考电压需为 0–10 V 范围内的正数');
    this.store.reset();this.total=0;this.lastFrame=null;this.adcDisplay=null;$('an-freeze').checked=false;
    this.renderAdc();
    this.status(count?'单次/有限记录采集中…':'连续 DMA 采集中…');
    await this.session.acquire(options,block=>{
      this.store.append(block);this.total=this.store.total;
      if(!$('an-freeze').checked&&this._raf===null)this._raf=requestAnimationFrame(()=>{this._raf=null;this.renderAdc();});
    });
    this.renderAdc();this.status(`采集停止，共 ${this.total} 点；保留最近 ${this.store.length} 点可导出`);
  }
  renderAdc(){
    const reference=Number($('an-reference').value),timeDiv=Number($('an-time').value);
    const voltsDiv=Number($('an-volts').value),offset=Number($('an-offset').value),level=Number($('an-level').value);
    if(!Number.isFinite(offset)||!Number.isFinite(level)||!Number.isFinite(reference)||reference<=0||!(timeDiv>0)||!(voltsDiv>0))return;
    const frozen=$('an-freeze').checked;
    let frame=frozen?this.lastFrame:this.store.frame({timeDiv,reference,trigger:$('an-trigger').value,level,edge:$('an-edge').value});
    const waiting=!frozen&&!frame&&$('an-trigger').value==='normal';
    if(frame)this.lastFrame=frame;
    else frame=this.lastFrame; // Normal trigger holds the last frame and its measurements.
    const duration=timeDiv*10;
    if(frame){
      const visible=Math.min(frame.codes.length,Math.max(1,Math.ceil(duration*frame.rate)));
      frame={...frame,codes:frame.codes.subarray(0,visible)};
    }
    this.adcDisplay={frame,reference,timeDiv,voltsDiv,offset,level,duration};
    const last=frame?.codes.length?frame.codes.at(-1):null;
    $('an-value').textContent=last===null?'— V':`${(last/(2**frame.bits-1)*reference).toFixed(5)} V`;
    $('an-code').textContent=last===null?'CH1 · 等待采集':`CH1 · code ${last}`;
    $('an-stats').textContent=`${this.total} 点 · 硬件时基 ${(this.store.rate/1000).toFixed(3)} kSa/s · 最近 ${this.store.length} 点可导出 · ${frozen?'冻结显示':waiting?'等待触发'+(frame?' · 保持上一帧':''):frame?.triggered?'已触发':'自动扫描'}${frame?.limited?' · 当前时窗超过记录长度':''}`;
    const measurement=measureAdc(frame?.codes,{rate:frame?.rate,bits:frame?.bits,reference});
    for(const [id,key,unit] of [['period','period','s'],['frequency','frequency','Hz'],['min','min','V'],['max','max','V'],['average','average','V'],['vpp','peakToPeak','V']])
      $('an-measure-'+id).textContent=formatMeasure(measurement[key],unit);
    $('an-measure-note').textContent=`当前显示窗口 · ${frame?.codes.length||0} 个原始样本${frozen?' · 冻结':''} · ${measurement.reason?'周期/频率：'+measurement.reason:'周期/频率为稳定边沿与波形重复性估算'}`;
    for(const id of ['period','frequency'])$('an-measure-'+id).title=$('an-measure-note').textContent;
    this.paintAdc();
  }
  paintAdc(){
    if(!this.adcDisplay)return;
    const {frame,reference,timeDiv,voltsDiv,offset,level,duration}=this.adcDisplay;
    const canvas=$('an-adc-canvas'),ctx=canvas.getContext('2d');if(!ctx)return;
    const {w,h}=this.canvasMetrics(canvas,ctx);ctx.fillStyle='#090f17';ctx.fillRect(0,0,w,h);
    ctx.strokeStyle='#26384a';ctx.lineWidth=1;
    for(let i=0;i<=10;i++){ctx.beginPath();ctx.moveTo(i*w/10,0);ctx.lineTo(i*w/10,h);ctx.stroke();}
    for(let i=0;i<=8;i++){ctx.beginPath();ctx.moveTo(0,i*h/8);ctx.lineTo(w,i*h/8);ctx.stroke();}
    const y=v=>h/2-(v-offset)/voltsDiv*h/8;
    ctx.setLineDash([5,5]);ctx.strokeStyle='#df9c42';ctx.beginPath();ctx.moveTo(0,y(level));ctx.lineTo(w,y(level));ctx.stroke();ctx.setLineDash([]);
    ctx.fillStyle='#d4e2f1';ctx.font=this.canvasFont;
    ctx.fillText(`CH1 PB14   ${voltsDiv} V/div   ${timeDiv<0.001?(timeDiv*1e6)+' us/div':(timeDiv*1000)+' ms/div'}`,12,20);
    if(!frame){this.paintAdcCursors(ctx,w,h);return;}
    const span=duration*frame.rate;
    const traceWidth=Math.min(w,Math.max(1,Math.ceil(frame.codes.length/span*w)));
    const points=envelope(frame.codes,traceWidth),scale=reference/(2**frame.bits-1);
    ctx.strokeStyle='#ffd15c';ctx.lineWidth=1.2;ctx.beginPath();
    if(frame.codes.length>traceWidth){
      for(const p of points){const x=p.x*frame.codes.length/span*w/points.length;ctx.moveTo(x,y(p.min*scale));ctx.lineTo(x,y(p.max*scale));}
    }else if(frame.codes.length===1){ctx.moveTo(0,y(frame.codes[0]*scale));ctx.lineTo(Math.min(3,w),y(frame.codes[0]*scale));}
    else frame.codes.forEach((code,i)=>{const x=i/span*w;if(i)ctx.lineTo(x,y(code*scale));else ctx.moveTo(x,y(code*scale));});
    ctx.stroke();
    this.paintAdcCursors(ctx,w,h);
  }
  initAdcCursors(){
    const reset=()=>{
      const d=this.adcDisplay||{duration:Number($('an-time').value)*10,offset:Number($('an-offset').value),voltsDiv:Number($('an-volts').value)};
      if($('an-cursor-x').checked)this.adcCursors.x=[d.duration*.25,d.duration*.75];
      if($('an-cursor-y').checked)this.adcCursors.y=[d.offset+d.voltsDiv*2,d.offset-d.voltsDiv*2];
    };
    for(const axis of ['x','y'])$('an-cursor-'+axis).addEventListener('change',()=>{
      if(!$('an-cursor-'+axis).checked)this.adcCursors[axis]=null;
      else if(!this.adcCursors[axis]){const keep=this.adcCursors[axis==='x'?'y':'x'];reset();this.adcCursors[axis==='x'?'y':'x']=keep;}
      this.paintAdc();
    });
    $('an-cursor-reset').addEventListener('click',()=>{reset();this.paintAdc();});
    $('an-cursor-clear').addEventListener('click',()=>{
      this.adcCursors={x:null,y:null};$('an-cursor-x').checked=$('an-cursor-y').checked=false;this.paintAdc();
    });
    for(const [id,axis,index] of [['t1','x',0],['t2','x',1],['v1','y',0],['v2','y',1]]){
      $('an-cursor-'+id).addEventListener('change',()=>{
        const value=$('an-cursor-'+id).value.trim(),number=Number(value);
        if(value!==''&&Number.isFinite(number)&&this.adcCursors[axis]){
          const d=this.adcDisplay;
          this.adcCursors[axis][index]=axis==='x'?Math.max(0,Math.min(d.duration,number/1e6)):
            Math.max(d.offset-4*d.voltsDiv,Math.min(d.offset+4*d.voltsDiv,number));
        }
        const accepted=this.adcCursors[axis]?.[index];
        $('an-cursor-'+id).value=accepted==null?'':String(+(accepted*(axis==='x'?1e6:1)).toPrecision(9));
        this.paintAdc();
      });
    }
    const canvas=$('an-adc-canvas');
    const point=e=>{const r=canvas.getBoundingClientRect();return {x:Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(e.clientY-r.top)/r.height)),w:r.width,h:r.height};};
    const move=(p,target)=>{
      const axis=target[0],index=Number(target[1]),d=this.adcDisplay;
      if(!d||!this.adcCursors[axis])return;
      this.adcCursors[axis][index]=axis==='x'?p.x*d.duration:d.offset+(0.5-p.y)*8*d.voltsDiv;
      this.paintAdc();
    };
    canvas.addEventListener('pointerdown',e=>{
      if(e.button!==0||!this.adcDisplay)return;
      const p=point(e),d=this.adcDisplay,candidates=[];
      for(const axis of ['x','y'])this.adcCursors[axis]?.forEach((value,i)=>{
        const distance=axis==='x'?Math.abs(p.x-value/d.duration)*p.w:
          Math.abs(p.y-(.5-(value-d.offset)/(8*d.voltsDiv)))*p.h;
        if(distance<=12)candidates.push({target:axis+i,distance});
      });
      candidates.sort((a,b)=>a.distance-b.distance);
      const target=candidates[0]?.target||$('an-cursor-target').value;
      if(!this.adcCursors[target[0]])return;
      this._cursorDrag={id:e.pointerId,target};$('an-cursor-target').value=target;
      canvas.focus({preventScroll:true});canvas.setPointerCapture(e.pointerId);e.preventDefault();move(p,target);
    });
    canvas.addEventListener('pointermove',e=>{if(this._cursorDrag?.id===e.pointerId)move(point(e),this._cursorDrag.target);});
    const end=e=>{if(this._cursorDrag?.id===e.pointerId){this._cursorDrag=null;if(canvas.hasPointerCapture(e.pointerId))canvas.releasePointerCapture(e.pointerId);}};
    for(const event of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(event,end);
    canvas.addEventListener('keydown',e=>{
      const target=$('an-cursor-target').value,axis=target[0],index=Number(target[1]),d=this.adcDisplay;
      if(!d||!this.adcCursors[axis]||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;
      e.preventDefault();const amount=e.shiftKey?10:1;
      if(axis==='x'&&['ArrowLeft','ArrowRight'].includes(e.key)){
        const step=d.frame?.rate?1/d.frame.rate:d.duration/1000;
        this.adcCursors.x[index]=Math.max(0,Math.min(d.duration,this.adcCursors.x[index]+(e.key==='ArrowRight'?1:-1)*amount*step));
      }else if(axis==='y'&&['ArrowUp','ArrowDown'].includes(e.key))
        this.adcCursors.y[index]=Math.max(d.offset-4*d.voltsDiv,Math.min(d.offset+4*d.voltsDiv,this.adcCursors.y[index]+(e.key==='ArrowUp'?1:-1)*amount*d.voltsDiv/100));
      this.paintAdc();
    });
  }
  paintAdcCursors(ctx,w,h){
    const d=this.adcDisplay;
    const colors={x:['#63bdff','#c591ff'],y:['#51dbb1','#ff9b73']};
    ctx.font=this.canvasFont;ctx.lineWidth=1;ctx.setLineDash([6,4]);
    for(const axis of ['x','y'])this.adcCursors[axis]?.forEach((value,i)=>{
      ctx.strokeStyle=ctx.fillStyle=colors[axis][i];ctx.beginPath();
      if(axis==='x'){
        const x=value/d.duration*w;if(x<0||x>w)return;
        ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke();
        ctx.fillText(`T${i+1} ${formatMeasure(value,'s')}`,Math.min(Math.max(4,x+5),Math.max(4,w-145)),h-12-i*17);
      }else{
        const y=h/2-(value-d.offset)/d.voltsDiv*h/8;if(y<0||y>h)return;
        ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();
        ctx.fillText(`V${i+1} ${formatMeasure(value,'V')}`,12,Math.max(40,Math.min(h-50,y-5)));
      }
    });
    ctx.setLineDash([]);
    for(const [id,axis,index] of [['t1','x',0],['t2','x',1],['v1','y',0],['v2','y',1]]){
      const input=$('an-cursor-'+id),value=this.adcCursors[axis]?.[index];input.disabled=value==null;
      if(document.activeElement!==input)input.value=value==null?'':String(+(value*(axis==='x'?1e6:1)).toPrecision(9));
    }
    const delta=cursorDelta(this.adcCursors);
    $('an-cursor-values').hidden=!this.adcCursors.x&&!this.adcCursors.y;
    $('an-cursor-time-values').hidden=!this.adcCursors.x;
    $('an-cursor-voltage-values').hidden=!this.adcCursors.y;
    const target=$('an-cursor-target');
    for(const option of target.options)option.disabled=!this.adcCursors[option.value[0]];
    if(!this.adcCursors[target.value[0]])target.value=[...target.options].find(o=>!o.disabled)?.value||'x0';
    $('an-cursor-dt').textContent=formatMeasure(delta.dt,'s');
    $('an-cursor-frequency').textContent=formatMeasure(delta.frequency,'Hz');
    $('an-cursor-dv').textContent=formatMeasure(delta.dv,'V');
  }
  preview(){
    this.wave = [];
    this.plot('an-dac-canvas',[]);$('an-generator-summary').textContent='';$('an-wave-state').textContent='';
    this.syncLevels();
    const options=this.waveOptions(),dc=options.shape==='dc',noise=options.shape==='noise';
    for(const id of ['an-amplitude','an-vpp','an-min','an-max'])$(id).disabled=dc;
    for(const id of ['an-frequency','an-phase'])$(id).disabled=dc||noise;
    $('an-duty').disabled=options.shape!=='pulse';$('an-points').disabled=!noise;
    const caps=this.session.dac?.caps?.supported?this.session.dac.caps:
      {maxRate:10000000,maxPoints:65535,bits:options.bits,fullScale:options.reference};
    const table=dacTable(options,caps);this.wave=table.rows;
    this.plot('an-dac-canvas', this.wave.map(r => r.volts),caps.fullScale);
    const amp=dc?0:options.amplitude,low=options.offset-amp,high=options.offset+amp;
    const freq=table.actualFrequency===null?(dc?'直流':'循环噪声表'):`${table.actualFrequency.toPrecision(6)} Hz`;
    $('an-generator-summary').textContent=`${WAVES[options.shape]} · ${freq} · ${2*amp} Vpp · 共模 ${options.offset} V · ${low.toPrecision(6)}–${high.toPrecision(6)} V`;
    $('an-wave-state').textContent=`${this.wave.length} 点${dc?'直流表':noise?'循环伪随机表':'完整一周期表'} · 更新率 ${options.rate} Sa/s · 表时长 ${(1000*this.wave.length/options.rate).toPrecision(6)} ms${table.actualFrequency===null?'':` · 请求 ${options.frequency} Hz，按整数点数量化`}。预览/导出不启动输出；硬件实际更新率以 START 应答为准。`;
    const ctx=$('an-dac-canvas').getContext('2d');
    if(ctx){const {h}=this.canvasMetrics($('an-dac-canvas'),ctx);ctx.fillStyle='#d4e2f1';ctx.font=this.canvasFont;ctx.fillText(`${caps.fullScale} V full scale`,12,20);ctx.fillText(`0 → ${(1000*this.wave.length/options.rate).toPrecision(6)} ms`,12,h-12);}
  }
  syncLevels(source='amplitude'){
    const levels=signalLevels({amplitude:Number($('an-amplitude').value),offset:Number($('an-dac-offset').value),
      min:Number($('an-min').value),max:Number($('an-max').value),vpp:Number($('an-vpp').value)},source);
    const dc=$('an-wave').value==='dc';
    for(const [id,value] of Object.entries({'an-amplitude':levels.amplitude,'an-dac-offset':levels.offset,
      'an-min':dc?levels.offset:levels.min,'an-max':dc?levels.offset:levels.max,'an-vpp':dc?0:levels.vpp}))$(id).value=String(Number(value.toPrecision(12)));
  }
  waveOptions(){
    const shape=$('an-wave').value,periodic=!['dc','noise'].includes(shape);
    return {shape,rate:Number($('an-update').value),frequency:periodic?Number($('an-frequency').value):1,amplitude:Number($('an-amplitude').value),offset:Number($('an-dac-offset').value),reference:Number($('an-dac-reference').value),bits:Number($('an-dac-bits').value),duty:shape==='pulse'?Number($('an-duty').value):50,phase:periodic?Number($('an-phase').value):0,points:Number($('an-points').value)};
  }
  updateDacControls(){
    const c=this.session.dac?.caps,enabled=this.session.connected && !!c?.supported;
    for(const id of ['an-dac-start','an-dac-stop','an-dac-status','an-dac-channel'])$(id).disabled=!enabled;
    $('an-dac-channel').innerHTML=enabled?Array.from({length:c.channels},(_,i)=>`<option value="${i}">通道 ${i+1}</option>`).join(''):'<option value="0">等待支持 DAC 的固件</option>';
    $('an-dac-reference').readOnly=enabled;
    for(const option of $('an-dac-bits').options)option.disabled=enabled && Number(option.value)!==c.bits;
    if(enabled){$('an-dac-reference').value=c.fullScale;$('an-dac-bits').value=c.bits;$('an-update').max=c.maxRate;}
    else $('an-update').max=10000000;
    $('an-points').max=enabled?c.maxPoints:65535;
    $('an-dac-state').textContent=enabled?`DAC 接口就绪：${c.channels} 通道、${c.bits} bit、最高 ${c.maxRate} Sa/s`:'DAC 已预留，当前未连接或固件不支持；仍可预览和导出';
  }
  plot(id, values, max = 3.3){
    const canvas = $(id), ctx = canvas.getContext('2d'); if (!ctx) return;
    const {w,h} = this.canvasMetrics(canvas,ctx); ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = '#666'; ctx.lineWidth = 0.5;
    for (let i = 1; i < 4; i++){ ctx.beginPath(); ctx.moveTo(0, i * h / 4); ctx.lineTo(w, i * h / 4); ctx.stroke(); }
    if (!values.length) return;
    ctx.strokeStyle = '#58a6ff'; ctx.lineWidth = 1.5; ctx.beginPath();
    values.forEach((v, i) => { const x = i * w / Math.max(1, values.length - 1), y = h - 8 - v / max * (h - 16); if (!i) ctx.moveTo(x, y); else ctx.lineTo(x, y); }); ctx.stroke();
  }
  canvasMetrics(canvas,ctx){
    const {w,h}=this.canvasSizes.get(canvas.id)||{w:1000,h:260},dpr=window.devicePixelRatio||1;
    const width=Math.round(w*dpr),height=Math.round(h*dpr);
    if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
    ctx.setTransform(dpr,0,0,dpr,0,0);
    return {w,h};
  }
  download(name, content){
    const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  onShow(){ this.renderAdc(); try { this.preview(); } catch (e){ $('an-wave-state').textContent = e.message; } }
  summary(){ return { connected: this.session.connected, busy: this.session.busy, caps: this.session.caps, samples: this.total, wavePoints: this.wave.length, dacAvailable:!!this.session.dac?.caps?.supported, dacOwned:!!this.session.dac?.owned }; }
}

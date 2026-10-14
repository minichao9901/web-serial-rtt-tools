import {SwoCapture,tracePlan} from './capture.js';
import {SerialSession} from '../serial/session.js';
import {SourceStore} from '../dbg/source.js';
import {Elf} from '../elf/elf.js';
import {SymTab} from '../dbg/symbols.js';
import {selectRange} from './analyze.js';
import {packRecording,unpackRecording,sha256,MAX_RAW,MAX_META} from './recording.js';
import {AkaLinkHid} from '../hid/probe.js';
import {matchedOptions} from './matching.js';
import {recomputeTarget} from './target.js';
import {COMMON_TARGETS,targetPort} from './ports.js';
import {receiverChain,periodForRate,LEGAL_PERIODS} from './planning.js';
import {simulate,DEFAULT_SOURCES} from './matching.js';
import {createZoomControls} from '../ui/zoom-controls.js';
import {sampleRangeFromPixels,zoomRangeAroundCursor} from './window.js';
const $=id=>document.getElementById(id),hex=v=>'0x'+(v>>>0).toString(16).padStart(8,'0');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const color=s=>{let h=0;for(const c of s)h=(h*31+c.charCodeAt(0))>>>0;return `hsl(${h%360} 65% 64%)`;};
// Board values for the bundled fixtures; editable inputs, never measured by RCC.
const BOARD_HSE_PRESETS_MHZ={stm32f1:8,stm32h7b0:25};
function download(bytes,name,type='application/octet-stream'){const url=URL.createObjectURL(new Blob([bytes],{type})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}
export class SwoView {
  constructor(){this.capture=new SwoCapture();this.sources=new SourceStore();this.recording=null;this.result=null;this.elf=null;this.symTab=null;this.entryBreakpoints=[];this.entryBreakpoint=null;this.haltedEntry=null;this.ports=[];this.page=0;this.cursor=0;this._analysisId=0;this._sourceId=0;this.hsePresetProfile='stm32f1';this.chartLayout=null;this.chartDrag=null;this.zoomControls=null;}
  get session(){return this.capture;}
  init(){
    const bind=(id,fn)=>$(id).addEventListener('click',()=>this.action(fn));
    this.initSidebar();
    this.zoomControls=createZoomControls({onZoomOut:()=>this.zoomChart(false),onZoomIn:()=>this.zoomChart(true),onFit:()=>this.fitChart()});
    $('sw-chart-zoom').replaceChildren(this.zoomControls.element);this.zoomControls.setDisabled({zoomOut:true,zoomIn:true,fit:true});
    bind('sw-pick',async()=>{const port=await SerialSession.requestPort();await this.refreshPorts();$('sw-port').value=String(this.ports.indexOf(port));});
    bind('sw-clock-grant',async()=>{const h=new AkaLinkHid();await h.request();await h.close();$('sw-clock-grant').textContent='时钟已授权';$('sw-match').textContent='探针时钟配置已授权；记录开始前将读回实际配置。';});
    bind('sw-chart-toggle',()=>{const box=$('sw-chart-box');box.hidden=!box.hidden;$('sw-chart-toggle').textContent=box.hidden?'展开轨迹图':'收起轨迹图';$('sw-chart-toggle').setAttribute('aria-expanded',String(!box.hidden));if(!box.hidden)this.draw();});
    const popovers=[$('sw-boundary-help'),$('sw-transition-help')];
    for(const details of popovers)details.addEventListener('toggle',()=>{if(details.open)for(const other of popovers)if(other!==details)other.open=false;});
    $('tab-swo').addEventListener('pointerdown',e=>{for(const details of popovers)if(!details.contains(e.target))details.open=false;});
    $('tab-swo').addEventListener('keydown',e=>{if(e.key==='Escape')for(const details of popovers)details.open=false;});
    bind('sw-detect',()=>this.detectTarget());bind('sw-export-c',()=>this.exportText('c'));bind('sw-export-txt',()=>this.exportText('simple-c'));bind('sw-start',()=>this.start());bind('sw-stop',()=>this.capture.stop());
    bind('sw-import',()=>$('sw-file').click());bind('sw-elf-pick',()=>$('sw-elf-file').click());bind('sw-entry-elf-pick',()=>$('sw-elf-file').click());
    bind('sw-source-pick',()=>{$('sw-source-files').click();});
    bind('sw-save',()=>{if(this.recording)download(packRecording(this.recording.raw,this.recording.metadata),'swo-'+Date.now()+'.swopc');});
    bind('sw-demo',()=>this.loadDemo());bind('sw-analyze',()=>this.analyze());bind('sw-csv',()=>this.exportCsv());
    for(const id of ['sw-core','sw-trace','sw-baud','sw-period','sw-seconds','sw-itm','sw-exceptions','sw-exception-rate','sw-itm-rate','sw-extra','sw-margin','sw-baud-round','sw-auto-baud','sw-timestamps'])$(id).addEventListener('change',()=>this.renderPlan());
    $('sw-hse').addEventListener('change',()=>this.action(()=>{this.hsePresetProfile=null;this.refreshTargetClock();}));
    $('sw-auto-clock').addEventListener('change',()=>this.target?this.showTarget(this.target):this.renderPlan());
    $('sw-file').addEventListener('change',()=>this.action(async()=>{const f=$('sw-file').files[0];if(!f)return;if(f.size>MAX_RAW+MAX_META+12)throw Error('记录文件超过大小限制');this.recording=unpackRecording(await f.arrayBuffer());if(this.recording.metadata.format==='raw')this.recording.metadata.startAligned=$('sw-aligned').checked;await this.analyze();}));
    $('sw-elf-file').addEventListener('change',()=>this.action(async()=>{const f=$('sw-elf-file').files[0];if(f)await this.loadElf(await f.arrayBuffer(),f.name);}));
    bind('sw-entry-set',()=>this.addEntryBreakpoint());bind('sw-entry-clear',()=>this.clearEntryBreakpoint());bind('sw-reset-entry',()=>this.resetAndHaltAtEntry());
    $('sw-symbol-search').addEventListener('input',()=>this.renderEntrySymbols());
    $('sw-entry-spec').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();this.action(()=>this.addEntryBreakpoint());}});
    $('sw-source-files').addEventListener('change',()=>this.action(async()=>{this.sources.indexFileList($('sw-source-files').files);this.renderFiles();if(this.result)await this.selectSample(this.cursor);}));
    $('sw-aligned').addEventListener('change',()=>this.action(async()=>{if(this.recording?.metadata.format==='raw'){this.recording.metadata.startAligned=$('sw-aligned').checked;await this.analyze();}}));
    bind('sw-range-apply',()=>this.renderRange());bind('sw-range-reset',()=>{this.fullRange();this.renderRange();});
    $('sw-filter').addEventListener('input',()=>this.renderRange());
    bind('sw-page-prev',()=>{this.page=Math.max(0,this.page-1);this.renderRows();});bind('sw-page-next',()=>{this.page=Math.min(Math.ceil((this.selection?.rows.length||0)/100)-1,this.page+1);this.renderRows();});
    bind('sw-prev',()=>this.selectSample(this.cursor-1));bind('sw-next',()=>this.selectSample(this.cursor+1));
    $('sw-cursor').addEventListener('input',()=>this.action(()=>this.selectSample(Number($('sw-cursor').value))));
    bind('sw-play',()=>{if(this.player){this.pause();return;}if(!this.result?.pcSamples.length)return;$('sw-play').textContent='暂停回放';this.player=setInterval(()=>{if(this.cursor>=this.result.pcSamples.length-1){this.pause();return;}this.action(()=>this.selectSample(this.cursor+1));},160);});
    const chart=$('sw-chart');
    chart.addEventListener('pointerdown',e=>this.chartPointerDown(e));chart.addEventListener('pointermove',e=>this.chartPointerMove(e));
    chart.addEventListener('pointerup',e=>this.chartPointerUp(e));chart.addEventListener('pointercancel',()=>{this.chartDrag=null;this.draw();});
    chart.addEventListener('wheel',e=>{if(!e.ctrlKey||!this.result?.pcSamples.length)return;e.preventDefault();this.zoomChart(e.deltaY<0);},{passive:false});
    chart.addEventListener('keydown',e=>{if(!this.result?.pcSamples.length)return;if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();this.action(()=>this.selectSample(this.cursor+(e.key==='ArrowLeft'?-1:1)));}else if(e.key==='Home'){e.preventDefault();this.action(()=>this.selectSample(this.from));}else if(e.key==='End'){e.preventDefault();this.action(()=>this.selectSample(this.to));}});
    this.capture.onError=e=>{this.error(e);};
    this.capture.onChange=()=>{if(this.capture.running){this._wasRecording=true;if(this.haltedEntry){this.haltedEntry=null;this.renderEntryState();}}
      if(this._wasRecording&&!this.capture.active){this._wasRecording=false;this.haltedEntry=null;this.renderEntryState();this.recording={raw:this.capture.raw(),metadata:structuredClone(this.capture.metadata)};this.action(()=>this.analyze());}this.renderCapture();if(!this.capture.active&&this._wasRecording===false)this.selectSidebar('analysis');};
    new ResizeObserver(()=>this.draw()).observe($('sw-chart'));
    this.refreshPorts().catch(e=>this.error(e));this.renderEntrySymbols();this.renderEntryState();this.renderPlan();this.renderCapture();
  }
  async action(fn){try{return await fn();}catch(e){this.error(e);}}
  error(e){$('sw-warning').textContent=e.message||String(e);$('sw-warning').classList.add('bad');}
  initSidebar(){
    const on=(id,fn)=>$(id).addEventListener('click',()=>this.action(fn));
    on('sw-record-tab',()=>this.selectSidebar('record'));on('sw-analysis-tab',()=>this.selectSidebar('analysis'));
    for(const id of ['sw-record-tab','sw-analysis-tab'])$(id).addEventListener('keydown',e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();const name=e.key==='Home'?'record':e.key==='End'?'analysis':id==='sw-record-tab'?'analysis':'record';this.selectSidebar(name);$('sw-'+name+'-tab').focus();}});
    on('sw-help-open',()=>$('sw-help').showModal());on('sw-help-close',()=>$('sw-help').close());
    for(const a of $('sw-help').querySelectorAll('a'))a.addEventListener('click',e=>{e.preventDefault();$(a.getAttribute('href').slice(1)).scrollIntoView({block:'start',behavior:'smooth'});});
    on('sw-calculator-open',()=>{this.fillCalculator();$('sw-calculator').showModal();this.renderCalculator();});on('sw-calculator-close',()=>$('sw-calculator').close());
    on('sw-calc-current',()=>{this.fillCalculator(true);this.renderCalculator();});
    on('sw-calc-help',()=>{$('sw-calculator').close();$('sw-help').showModal();});
    on('sw-calc-copy',()=>this.applyCalculator());
    for(const input of $('sw-calculator').querySelectorAll('input,select'))input.addEventListener('input',()=>{if(input.id==='sw-calc-model'){const port=targetPort(input.value);$('sw-calc-core').value=port?.maxCoreHz/1e6||72;$('sw-calc-relation').value=port?.traceDiv===null||!port?'manual':String(port.traceDiv);if($('sw-calc-relation').value==='manual')$('sw-calc-trace').value='';}this.renderCalculator();});
    $('sw-model').addEventListener('change',()=>{this.target=null;const profile=$('sw-model').value,hse=BOARD_HSE_PRESETS_MHZ[profile];this.hsePresetProfile=hse===undefined?null:profile;$('sw-hse').value=hse??'';$('sw-core').value='';$('sw-trace').value='';$('sw-target').textContent='型号已切换，请重新识别目标';$('sw-target-path').textContent='请重新识别 CPU / Trace 时钟来源与分频。';this.renderPlan();});
    for(const select of [$('sw-period'),$('sw-calc-period')])for(const n of LEGAL_PERIODS)if(![...select.options].some(o=>Number(o.value)===n)){const o=document.createElement('option');o.value=n;o.textContent=n+' 周期';select.append(o);}
    for(const select of [$('sw-period'),$('sw-calc-period')]){const selected=select.value;select.replaceChildren(...[...select.options].sort((a,b)=>Number(a.value)-Number(b.value)));select.value=selected;}
  }
  selectSidebar(name){for(const n of ['record','analysis']){const selected=n===name;$('sw-'+n+'-panel').hidden=!selected;$('sw-'+n+'-tab').setAttribute('aria-selected',String(selected));$('sw-'+n+'-tab').tabIndex=selected?0:-1;}}
  options(){return {profile:$('sw-model').value,hseForProfile:this.hsePresetProfile,extraBytes:Number($('sw-extra').value),occupancy:1-Number($('sw-margin').value)/100,coreHz:Number($('sw-core').value)*1e6,traceHz:Number($('sw-trace').value)*1e6,baudRate:Number($('sw-baud').value),periodCycles:Number($('sw-period').value),seconds:Number($('sw-seconds').value),itm:$('sw-itm').checked,exceptions:$('sw-exceptions').checked,exceptionEvents:Number($('sw-exception-rate').value),itmBytes:Number($('sw-itm-rate').value),autoClock:$('sw-auto-clock').checked,hseHz:$('sw-hse').value?Number($('sw-hse').value)*1e6:null,allowBaudRounding:$('sw-baud-round').checked,autoBaud:$('sw-auto-baud').checked,receiverMode:2,timestamps:$('sw-timestamps').checked};}
  renderPlan(){
    for(const id of ['sw-core','sw-trace'])$(id).disabled=this.capture.active||$('sw-auto-clock').checked;
    $('sw-baud').disabled=this.capture.active||$('sw-auto-baud').checked;
    $('sw-exception-budget').hidden=!$('sw-exceptions').checked;$('sw-itm-budget').hidden=!$('sw-itm').checked;
    const summary=$('sw-match-summary');summary.classList.remove('bad');
    try{
      const o=this.options();
      if(!o.coreHz||!o.traceHz){summary.textContent=this.target?.external&&!o.hseHz?'主频待确认 · 请填写外部时钟':'先识别目标与时钟，或填写 CPU / Trace 频率';$('sw-match').textContent='CPU 和 SWO 输入频率确认后计算收发配置';$('sw-plan').textContent='尚未确定采样率';$('sw-receiver-path')?.remove();return;}
      if(!o.autoBaud&&!Number.isInteger(o.baudRate))throw Error('手动 SWO 波特率必须为 1–30000000 的整数');
      const sources=this.capture.receiverSources?.frequencies||DEFAULT_SOURCES,preview=matchedOptions(o,sources);
      const p=this.capture.running?this.capture.metadata.plan:tracePlan(preview),r=this.capture.running?this.capture.metadata.receiver:null,c=r||preview.receiverEstimate;
      if(o.autoBaud)$('sw-baud').value=Math.round(p.baudRate);
      const error=c?Math.abs(c.actualBaud-p.baudRate)/p.baudRate:1,tight=p.estimatedBytes>p.wireBytes*p.occupancy;
      summary.textContent=(r?'已回读 · ':'预计 · ')+`${(p.baudRate/1e6).toLocaleString('zh-CN',{maximumFractionDigits:6})} Mbps · ${(p.samplesHz/1000).toFixed(1)}k PC/s`+(tight?' · 带宽偏紧':'')+(error>.005?' · 接收误差过大':'');summary.classList.toggle('bad',tight||error>.005);
      $('sw-match').textContent=(r?'已回读：':'计算预览：')+`目标 Trace ${(p.traceHz/1e6).toFixed(6)} MHz ÷ ${p.acpr+1} → SWO ${(p.baudRate/1e6).toFixed(6)} Mbps\n`+receiverChain(c,sources)+`\n收发误差 ${(error*100).toFixed(6)}%`;
      $('sw-plan').textContent=`约 ${p.samplesHz.toLocaleString('zh-CN',{maximumFractionDigits:0})} PC 样本/s · 全为 PC 时最低需 ${(p.pcMinimumBaud/1e6).toFixed(3)} Mbps · ${p.timestamps?'含时间戳':'仅 PC 包'}预计 ${(p.estimatedBytes/1000).toFixed(1)} KB/s / 线路 ${(p.wireBytes/1000).toFixed(0)} KB/s`+(p.baudError?` · 请求 ${p.requestedBaudRate} baud，目标实际 ${p.baudRate.toFixed(3)} baud`:'')+(p.pcMinimumBaud>30e6?' · PC 包需求已超过探针 30 Mbps 上限':tight?' · 带宽偏紧，建议增大 PC 间隔':'');
      $('sw-receiver-path')?.remove();const path=document.createElement('p');path.id='sw-receiver-path';path.className='hint';path.textContent=c?`${['24M','PLL0CLK0','PLL0CLK1','PLL0CLK2','PLL1CLK0','PLL1CLK1','PLL1CLK2','PLL1CLK3'][c.source]} ÷${c.systemDivider??c.sysdiv} → UART ${c.uartHz/1e6} MHz · OSR ${c.osr} · DIV ${c.uartDivider??c.div}${c.retune?'（计划调 PLL1）':''}`:'没有可用接收分频';summary.after(path);
    }catch(e){const o=this.options(),rate=o.coreHz/o.periodCycles;$('sw-plan').textContent=`约 ${rate.toLocaleString('zh-CN',{maximumFractionDigits:0})} PC 样本/s · 全为 PC 时最低需 ${(rate*50/1e6).toFixed(3)} Mbps · ${rate*50>30e6?'已超过探针 30 Mbps 上限；':''}${e.message}`;$('sw-match').textContent=e.message;summary.textContent=e.message;summary.classList.add('bad');$('sw-receiver-path')?.remove();}
  }
  fillCalculator(requireTarget=false){
    const o=this.options();if(requireTarget&&(!o.coreHz||!o.traceHz))throw Error('请先识别目标时钟或填写当前频率');
    if(o.coreHz&&o.traceHz){$('sw-calc-model').value=this.target?.profile==='unknown'?'custom':this.target?.profile||'custom';$('sw-calc-core').value=o.coreHz/1e6;const ratio=o.coreHz/o.traceHz;$('sw-calc-relation').value=[1,2,4].includes(ratio)?String(ratio):'manual';$('sw-calc-trace').value=o.traceHz/1e6;}
    $('sw-calc-period').value=o.periodCycles;$('sw-calc-timestamps').checked=o.timestamps;$('sw-calc-exceptions').checked=o.exceptions;$('sw-calc-itm').checked=o.itm;$('sw-calc-exception-rate').value=o.exceptionEvents;$('sw-calc-itm-rate').value=o.itmBytes;$('sw-calc-extra').value=o.extraBytes;$('sw-calc-margin').value=Number(((1-o.occupancy)*100).toFixed(6));
  }
  calculatorOptions(){const coreHz=Number($('sw-calc-core').value)*1e6,relation=$('sw-calc-relation').value;
    const traceHz=relation==='manual'?Number($('sw-calc-trace').value)*1e6:coreHz/Number(relation),periodCycles=$('sw-calc-rate-mode').value==='rate'?periodForRate(coreHz,Number($('sw-calc-rate').value)):Number($('sw-calc-period').value);
    return {coreHz,traceHz,periodCycles,timestamps:$('sw-calc-timestamps').checked,exceptions:$('sw-calc-exceptions').checked,itm:$('sw-calc-itm').checked,exceptionEvents:Number($('sw-calc-exception-rate').value),itmBytes:Number($('sw-calc-itm-rate').value),extraBytes:Number($('sw-calc-extra').value),occupancy:1-Number($('sw-calc-margin').value)/100};
  }
  renderCalculator(){
    const result=$('sw-calc-result');this.calculation=null;$('sw-calc-copy').disabled=true;
    $('sw-calc-trace').disabled=$('sw-calc-relation').value!=='manual';$('sw-calc-rate-row').hidden=$('sw-calc-rate-mode').value!=='rate';$('sw-calc-period-row').hidden=!$('sw-calc-rate-row').hidden;
    $('sw-calc-exception-rate').disabled=!$('sw-calc-exceptions').checked;$('sw-calc-itm-rate').disabled=!$('sw-calc-itm').checked;
    try{const o=this.calculatorOptions(),port=targetPort($('sw-calc-model').value);
      if(!o.coreHz||!o.traceHz||!Number.isFinite(o.coreHz)||!Number.isFinite(o.traceHz)||o.coreHz>1e9||o.traceHz>1e9)throw Error('请提供有效的 CPU 和 Trace 输入频率');
      if(port&&o.coreHz>port.maxCoreHz)throw Error(`${port.name} 的核心频率不能超过 ${port.maxCoreHz/1e6} MHz`);
      $('sw-calc-trace').value=o.traceHz/1e6;const s=simulate(o,this.capture.receiverSources?.frequencies||DEFAULT_SOURCES),b=s.budget,p=s.plan;
      this.calculation={...s,options:o};result.classList.toggle('bad',!!s.error);
      result.textContent=`CPU ${o.coreHz/1e6} MHz ÷ ${o.periodCycles} 周期 = ${b.samplesHz.toLocaleString('zh-CN',{maximumFractionDigits:2})} PC/s\nPC：${b.bytesPerSample} B/样本；异常 ${b.exceptionBytes.toFixed(0)} B/s；ITM ${b.itmBytes.toFixed(0)} B/s；总计 ${b.estimatedBytes.toFixed(0)} B/s\n所需 baud = ${b.estimatedBytes.toFixed(0)} ×10 ÷ ${b.occupancy.toFixed(2)} = ${(b.requiredBaud/1e6).toFixed(6)} Mbps\n`+(p?`Trace ${o.traceHz/1e6} MHz ÷ ${p.acpr+1} → SWO ${(p.baudRate/1e6).toFixed(6)} Mbps（ACPR / CODR ${p.acpr}）\n${receiverChain(s.matched.receiverEstimate,this.capture.receiverSources?.frequencies||DEFAULT_SOURCES)}\n误差 ${(s.matched.receiverEstimate.error*100).toFixed(6)}%；预计线路占用 ${(b.estimatedBytes/(p.baudRate/10)*100).toFixed(1)}%`:s.error)+`\n保持此采样间隔 / 事件预算，30 Mbaud 带宽允许 CPU 上界约 ${(Math.min(s.maxCoreHz,port?.maxCoreHz??1e9)/1e6).toFixed(3)} MHz（目标合法 PLL 档位须由目标程序确认）`+(s.nextPeriod?`；当前主频可尝试 ${s.nextPeriod} 周期或更大间隔`:'；当前事件预算已无法满足带宽');
      $('sw-calc-copy').disabled=this.capture.active||!p;
    }catch(e){result.textContent=e.message;result.classList.add('bad');}
  }
  applyCalculator(){const c=this.calculation;if(this.capture.active||!c?.plan)return;const o=c.options;
    $('sw-period').value=o.periodCycles;$('sw-timestamps').checked=o.timestamps;$('sw-exceptions').checked=o.exceptions;$('sw-itm').checked=o.itm;$('sw-exception-rate').value=o.exceptionEvents;$('sw-itm-rate').value=o.itmBytes;$('sw-extra').value=o.extraBytes;$('sw-margin').value=Number(((1-o.occupancy)*100).toFixed(6));$('sw-auto-baud').checked=true;
    $('sw-calculator').close();this.selectSidebar('record');this.renderPlan();
  }
  async refreshPorts(){const current=this.ports[Number($('sw-port').value)];this.ports=(await SerialSession.listPorts()).filter(p=>{const i=p.getInfo();return i.usbVendorId===0x0d28&&i.usbProductId===0x0204;});$('sw-port').replaceChildren();this.ports.forEach((p,i)=>{const o=document.createElement('option');o.value=i;o.textContent=`VCOM ${i+1} · ${SerialSession.describe(p)}`;$('sw-port').append(o);});if(current&&this.ports.includes(current))$('sw-port').value=this.ports.indexOf(current);}
  async loadElf(buffer,name='firmware.elf'){
    if(this.capture.active)throw Error('记录期间不能切换 ELF');if(buffer.byteLength>128*1024*1024)throw Error('ELF 超过 128 MiB');
    const elf=new Elf(buffer),symTab=SymTab.fromBuffer(elf);this.elf={buffer,elf,name,sha256:await sha256(buffer)};this.symTab=symTab;this.entryBreakpoints=[];this.entryBreakpoint=null;this.haltedEntry=null;$('sw-symbol-search').value='';$('sw-entry-spec').value='';this.renderEntrySymbols();this.renderEntryState();this.renderFiles();this.renderCapture();if(this.recording)await this.analyze();
  }
  renderEntrySymbols(){
    const list=$('sw-entry-functions'),query=$('sw-symbol-search').value.trim().toLowerCase(),seen=new Set(),rows=[];
    for(const fn of [...(this.symTab?.funcs||[])].sort((a,b)=>a.name.localeCompare(b.name)||a.addr-b.addr)){
      const address=(fn.addr&~1)>>>0,key=fn.name+'\0'+address;if(!fn.name||seen.has(key))continue;seen.add(key);
      if(query&&!(fn.name+' '+hex(address)).toLowerCase().includes(query))continue;
      const existing=this.entryBreakpoints.find(bp=>bp.address===address),row=document.createElement('div');row.className='sw-symbol-row';
      const add=document.createElement('button');add.type='button';add.textContent=existing?'●':'＋';add.title=existing?'已添加；选择为采集起点':'添加 '+fn.name+' 断点';add.setAttribute('aria-label',(existing?'选择断点 ':'添加断点 ')+fn.name);add.disabled=this.capture.active;
      add.addEventListener('click',()=>this.action(()=>{if(existing)this.selectEntryBreakpoint(address);else this.setEntryBreakpoint('*'+hex(address),{select:!this.entryBreakpoint,label:fn.name});$('sw-entry-spec').value='';}));
      const name=document.createElement('span');name.className='sw-symbol-name';name.textContent=fn.name;name.title=fn.name+' · '+hex(address);const pc=document.createElement('small');pc.textContent=hex(address);row.append(add,name,pc);rows.push(row);
    }
    list.replaceChildren(...rows);if(!rows.length)list.textContent=this.symTab?'没有匹配函数':'先浏览载入 ELF';
  }
  renderEntryState(){
    $('sw-entry-elf-info').textContent=this.elf?`${this.elf.name}\nELF ${this.elf.sha256.slice(0,12)} · ${this.symTab.funcs.length} 个函数`:'尚未载入 ELF';$('sw-entry-elf-info').title=this.elf?this.elf.sha256:'';
    const rows=this.entryBreakpoints.map(bp=>{
      const row=document.createElement('div');row.className='sw-breakpoint-row'+(bp===this.entryBreakpoint?' selected':'');
      const select=document.createElement('input');select.type='radio';select.name='sw-capture-entry';select.checked=bp===this.entryBreakpoint;select.disabled=this.capture.active;select.setAttribute('aria-label','采集起点 '+bp.label);select.addEventListener('change',()=>this.action(()=>this.selectEntryBreakpoint(bp.address)));
      const description=document.createElement('span');description.className='sw-breakpoint-description';description.textContent=bp.label;description.title=bp.file||bp.label;const pc=document.createElement('small');pc.textContent=hex(bp.address)+(bp===this.entryBreakpoint?' · 采集起点':'');description.append(pc);
      const del=document.createElement('button');del.type='button';del.textContent='×';del.disabled=this.capture.active;del.setAttribute('aria-label','删除断点 '+bp.label);del.addEventListener('click',()=>this.action(()=>this.removeEntryBreakpoint(bp.address)));row.append(select,description,del);return row;
    });
    $('sw-breakpoint-list').replaceChildren(...rows);if(!rows.length)$('sw-breakpoint-list').textContent='无断点；从函数前 ＋ 或命令添加。';
    $('sw-entry-state').textContent=this.entryBreakpoint?`采集起点：${this.entryBreakpoint.label} · ${hex(this.entryBreakpoint.address)}`:'请选择一个断点作为采集起点';
    const control=$('sw-entry-control-status');if(this.haltedEntry)control.textContent=this.entryBreakpoint?.address===this.haltedEntry.address?`目标已复位并停在起点 ${hex(this.haltedEntry.address)}`:`目标目前停在 ${this.haltedEntry.label} · ${hex(this.haltedEntry.address)}；采集时会运行到新起点`;
    else control.textContent=this.target?'目标已识别；可复位并停到所选起点。':'识别目标并选择断点后，可复位并停在起点。';
    $('sw-entry-clear').disabled=!this.entryBreakpoints.length||this.capture.active;
  }
  setEntryBreakpoint(spec=$('sw-entry-spec').value,{select=true,label=null}={}){
    if(this.capture.active)throw Error('采集期间不能更改起点断点');
    if(!this.symTab||!this.elf)throw Error('请先载入与目标固件匹配的 ELF');
    const text=String(spec||'').trim(),command=text.replace(/^(?:b|break)\s+/i,'');
    if(!command)throw Error('输入函数名或 b 文件:行，例如 pipeline_scan 或 b main.c:199');
    const resolved=this.symTab.breakSpec(command);if(resolved.error)throw Error(resolved.error);
    const address=(Number(resolved.addr)>>>0)&~1,executable=this.symTab.elf.sections().some(s=>(s.flags&4)&&s.size&&address>=s.addr&&address<s.addr+s.size);
    if(!executable)throw Error('采集断点必须落在 ELF 的可执行代码段');
    let bp=this.entryBreakpoints.find(item=>item.address===address);
    if(!bp){bp={address,label:label||resolved.label||resolved.sym?.name||command,requested:text,file:resolved.file||'',line:resolved.line||0};this.entryBreakpoints.push(bp);}
    if(select)this.entryBreakpoint=bp;
    this.renderEntrySymbols();this.renderEntryState();this.renderCapture();return bp;
  }
  addEntryBreakpoint(){const bp=this.setEntryBreakpoint($('sw-entry-spec').value,{select:!this.entryBreakpoint});$('sw-entry-spec').value='';return bp;}
  selectEntryBreakpoint(address){if(this.capture.active)throw Error('采集期间不能更改起点断点');const bp=this.entryBreakpoints.find(item=>item.address===address);if(!bp)throw Error('此断点已被删除');this.entryBreakpoint=bp;this.renderEntryState();this.renderCapture();}
  removeEntryBreakpoint(address){if(this.capture.active)throw Error('采集期间不能更改起点断点');this.entryBreakpoints=this.entryBreakpoints.filter(item=>item.address!==address);if(this.entryBreakpoint?.address===address)this.entryBreakpoint=null;this.renderEntrySymbols();this.renderEntryState();this.renderCapture();}
  clearEntryBreakpoint(){if(this.capture.active)throw Error('采集期间不能更改起点断点');this.entryBreakpoints=[];this.entryBreakpoint=null;this.renderEntrySymbols();this.renderEntryState();this.renderCapture();}
  async resetAndHaltAtEntry(){
    if(!this.target)throw Error('请先连接探针并识别目标');if(!this.elf||!this.entryBreakpoint)throw Error('请先载入匹配 ELF 并选择采集起点');
    this.haltedEntry=null;this.renderEntryState();this.capture.probeManager=this.probeManager;
    const entry=this.entryBreakpoint,result=await this.capture.resetToEntry({...this.options(),entryAddress:entry.address,entryLabel:entry.label,elfSha256:this.elf.sha256,verifyElf:probe=>this.verifyElf(probe),onTarget:target=>this.showTarget(target)});
    this.haltedEntry={address:result.hitPc,label:entry.label};this.renderEntryState();this.renderCapture();return result;
  }
  async loadDemo(){
    if(this.capture.active)throw Error('请先停止记录再载入示例');this.pause();
    const get=async path=>{const response=await fetch(new URL('../../'+path,import.meta.url));if(!response.ok)throw Error('示例文件读取失败：'+path);return response;};
    const base='tools/target-firmware/stm32f103cb_swo/';
    const [record,elf,...source]=await Promise.all([get('samples/swo/f103cb-route-b.swopc').then(r=>r.arrayBuffer()),get(base+'fw.elf').then(r=>r.arrayBuffer()),...['main.c','pipeline.c','startup.c','pipeline.h'].map(n=>get(base+'src/'+n).then(r=>r.text()).then(t=>new File([t],n)))]);
    this.recording=null;this.sources.indexFileList(source);await this.loadElf(elf,'F103CB 实测示例 ELF');this.recording=unpackRecording(record);await this.analyze();
  }
  async verifyElf(probe){
    if(!this.elf)return;const elf=this.elf.elf;
    const sections=elf.sections().filter(s=>(s.flags&2)&&(s.flags&4)&&s.size).slice(0,32);
    if(!sections.length)throw Error('ELF 没有可校验的执行段');
    for(const s of sections){for(const offset of [...new Set([0,Math.max(0,s.size-64)])]){const n=Math.min(64,s.size-offset),expected=elf.bytesAt(s.addr+offset,n,{ro:true});if(!expected)continue;let confirmed=0;for(let i=0;i<4&&confirmed<2;i++){const actual=await probe.readMemDiagnostic(s.addr+offset,n);confirmed=actual.length===n&&!actual.some((v,i)=>v!==expected[i])?confirmed+1:0;}if(confirmed<2){const error=Error('目标代码与 ELF 不符或读回不稳定：'+s.name+' '+hex(s.addr+offset));error.code='SWO_ELF_VERIFY';throw error;}}}
  }
  showTarget(target){
    if(this.hsePresetProfile&&target.profile!==this.hsePresetProfile){const hse=BOARD_HSE_PRESETS_MHZ[target.profile];$('sw-hse').value=hse??'';this.hsePresetProfile=hse===undefined?null:target.profile;target=recomputeTarget(target,hse===undefined?null:hse*1e6);}
    this.target=target;if($('sw-auto-clock').checked){$('sw-core').value=target.knownHz===null?'':target.knownHz/1e6;$('sw-trace').value=target.knownTraceHz==null?'':target.knownTraceHz/1e6;}
    const frequency=target.knownHz===null?'主频待确认':`当前 ${target.knownHz/1e6} MHz`,trace=target.knownTraceHz==null?'Trace 待确认':`Trace ${target.knownTraceHz/1e6} MHz`;
    const missingHse=target.external&&target.hseHz==null;
    const source=target.external&&this.hsePresetProfile===target.profile&&!missingHse?target.source.replace(/^HSE/,`HSE ${target.hseHz/1e6} MHz（预设）`):target.source;
    $('sw-target').textContent=`${target.name} · ${target.core}\nCPU ${frequency} · ${trace}\n${missingHse?'已识别 HSE 路径；请填写板载 HSE MHz':`${source} · SWO ${target.swoPin}`}`;
    $('sw-target').title=`CPUID ${hex(target.cpuid)} · DEV_ID ${hex(target.device)}\n${target.path}\n${target.tracePath||target.traceRelation}`;
    $('sw-target-path').textContent=`CPU：${target.path}\nSWO：${target.tracePath||target.traceRelation}`;
    if(missingHse){const clocks=[...document.querySelectorAll('#sw-record-steps details')].find(details=>details.querySelector('#sw-hse'));if(clocks)clocks.open=true;}
    $('sw-target').classList.toggle('bad',target.knownHz===null||target.knownTraceHz==null);this.renderPlan();
  }
  refreshTargetClock(){
    if(!this.target||this.capture.active){this.renderPlan();return;}
    try{this.showTarget(recomputeTarget(this.target,this.options().hseHz));}
    catch(e){this.showTarget({...this.target,knownHz:null,knownTraceHz:null,coreHz:null,traceHz:null});throw e;}
  }
  async detectTarget(){
    this.capture.probeManager=this.probeManager;
    try{this.showTarget(await this.capture.inspect(this.options()));if(this.result)this.renderStats();else{$('sw-warning').textContent='';$('sw-warning').classList.remove('bad');}}
    catch(e){this.target=null;if($('sw-auto-clock').checked){$('sw-core').value='';$('sw-trace').value='';}$('sw-target').textContent='识别失败 · 请检查 SWD 连接与外晶设置';$('sw-target-path').textContent='CPU / Trace 时钟来源未确认。';$('sw-target').classList.add('bad');this.renderPlan();throw e;}
  }
  async start(){
    this.pause();$('sw-warning').textContent='';$('sw-warning').classList.remove('bad');$('sw-export-status').textContent='';await this.refreshPorts();
    if(!this.elf||!this.entryBreakpoint)throw Error('SWO 采集必须先载入匹配 ELF 并设置函数/源码行断点');
    const options={...this.options(),port:this.ports[Number($('sw-port').value)],elfSha256:this.elf.sha256,elf:this.elf.elf,verifyElf:p=>this.verifyElf(p),entryAddress:this.entryBreakpoint.address,entryLabel:this.entryBreakpoint.label,onTarget:t=>this.showTarget(t)};
    this.capture.probeManager=this.probeManager;await this.capture.start(options);
  }
  renderCapture(){const c=this.capture,active=c.active||!!this.exporting;
    $('sw-start').disabled=active||!!this.analyzing||!this.elf||!this.entryBreakpoint;$('sw-stop').disabled=!c.active;$('sw-reset-entry').disabled=active||!this.target||!this.elf||!this.entryBreakpoint;
    for(const id of ['sw-port','sw-pick','sw-core','sw-trace','sw-baud','sw-period','sw-seconds','sw-itm','sw-exceptions','sw-elf-pick','sw-entry-elf-pick','sw-entry-spec','sw-entry-set','sw-entry-clear','sw-demo','sw-import','sw-aligned','sw-detect','sw-auto-clock','sw-hse','sw-baud-round','sw-source-pick','sw-auto-baud','sw-model','sw-exception-rate','sw-itm-rate','sw-extra','sw-margin','sw-timestamps','sw-clock-grant'])$(id).disabled=active;
    $('sw-symbol-search').disabled=active||!this.symTab;$('sw-entry-spec').disabled=active||!this.symTab;$('sw-entry-set').disabled=active||!this.symTab;$('sw-entry-clear').disabled=active||!this.entryBreakpoints.length;
    for(const control of document.querySelectorAll('#sw-entry-functions button,#sw-breakpoint-list input,#sw-breakpoint-list button'))control.disabled=active;
    $('sw-status').textContent=c.running?`记录中 · ${(c.bytes/1024).toFixed(1)} KiB${this.result?" · 图表为上次分析结果":""}`:(c.busy?(c.startPhase||'正在连接并配置 SWO…'):c.probe?'正在恢复 trace 配置…':c.bytes?`记录结束 · ${(c.bytes/1024).toFixed(1)} KiB · ${c.metadata.restored?'配置已恢复':'恢复未确认'}`:'尚未记录');
    $('sw-save').disabled=!this.recording||active;$('sw-analyze').disabled=!this.recording||active||this.analyzing;$('sw-csv').disabled=!this.result||active||this.analyzing;for(const id of ['sw-export-c','sw-export-txt'])$(id).disabled=!this.recording||active||this.analyzing;this.renderPlan();
  }
  renderFiles(){$('sw-files').textContent=(this.elf?`${this.elf.name} · ELF SHA256 ${this.elf.sha256.slice(0,12)}`:'未载入 ELF')+' · '+this.sources.summary();}
  pause(){clearInterval(this.player);this.player=null;$('sw-play').textContent='逐样本回放';}
  async analyze(){
    if(!this.recording||this.capture.active)return;this.pause();this.worker?.terminate();this._cancelAnalysis?.();const id=++this._analysisId;this.analyzing=true;this.result=null;this.selection=null;this.renderCapture();this.clearResult();$('sw-counts').textContent='正在后台解码…';
    const worker=this.worker=new Worker(new URL('./worker.js',import.meta.url),{type:'module'});
    try{const result=await new Promise((resolve,reject)=>{this._cancelAnalysis=()=>resolve(null);worker.onmessage=({data})=>data.error?reject(Error(data.error)):resolve(data.result);worker.onerror=e=>reject(Error('离线解码失败：'+e.message));worker.postMessage({id,raw:this.recording.raw,metadata:this.recording.metadata,elf:this.elf?.buffer||null});});
      if(id!==this._analysisId||!result)return;this.result=result;await this.sources.setExpectedPaths(result.paths);if(id!==this._analysisId)return;this.renderFiles();this.fullRange();this.renderRange();this.renderStats();if(result.pcSamples.length)await this.selectSample(0);
    }catch(e){if(id===this._analysisId){this.clearResult();this.error(e);}throw e;}finally{worker.terminate();if(id===this._analysisId){this.worker=null;this._cancelAnalysis=null;this.analyzing=false;this.renderCapture();}}
  }
  clearResult(){this._sourceId++;for(const id of ['sw-hot','sw-rows','sw-source','sw-source-title','sw-edges','sw-page-info','sw-cursor-text'])$(id).replaceChildren();const canvas=$('sw-chart');canvas.getContext('2d').clearRect(0,0,canvas.width,canvas.height);$('sw-counts').textContent='尚无分析结果';$('sw-cursor').max=0;$('sw-cursor').value=0;this.from=0;this.to=0;this.cursor=0;this.chartDrag=null;this.chartLayout=null;this.zoomControls?.setDisabled({zoomOut:true,zoomIn:true,fit:true});}
  renderStats(){const r=this.result,s=r.stats;$('sw-counts').textContent=`${s.analyzedSamples.toLocaleString()} PC · ${r.hotspots.length} 个位置 · 缺口 ${r.events.filter(e=>e.kind==='gap').length} · 睡眠包 ${s.sleep} · 中断 ${s.exceptions}`;
    const notes=[];if(Object.values(r.metadata.receiverErrors||{}).some(v=>v))notes.push('探针接收诊断：'+Object.entries(r.metadata.receiverErrors).filter(([,v])=>v).map(([k,v])=>k+'='+v).join('、'));if(r.metadata.limitReached)notes.push('达到 32 MiB 上限，记录已停止');if(r.metadata.errorLimitReached)notes.push('传输错误过多，记录已停止');if(this.elf?.name==='F103CB 实测示例 ELF')notes.push('正在查看 F103CB 离线实测示例');if(r.metadata.clockCheck?.knownHz===null)notes.push('外部时钟无法由 RCC 单独确定，波特率与时间换算使用填写的核心频率');if(!this.elf)notes.push('未载入 ELF，只显示原始地址');else if(!r.metadata.elfSha256)notes.push('记录未保存 ELF 指纹，映射依赖所选 ELF 与实际固件一致');
    if(r.metadata.entryBreakpoint)notes.push(`断点起点：${r.metadata.entryBreakpoint.label} · 命中 ${hex(r.metadata.entryBreakpoint.hitPc)}`);if(s.unmapped)notes.push(`${s.unmapped} 个 PC 未精确落入函数符号`);if(s.skippedBytes)notes.push(`同步前跳过 ${s.skippedBytes} 字节`);if(s.overflow)notes.push(`ITM 溢出 ${s.overflow} 次`);if(s.malformed)notes.push(`未知/损坏数据包 ${s.malformed} 次`);if(s.truncated)notes.push('末尾存在截断包');if(s.droppedEvents)notes.push(`仅分析前 250000 条事件，另有 ${s.droppedEvents} 条未展开（原始记录保留）`);if(r.metadata.transportGaps?.length)notes.push(`传输错误 ${r.metadata.transportGaps.length} 次`);if(r.symbolNote)notes.push(r.symbolNote);
    $('sw-warning').textContent=notes.join('；');$('sw-warning').classList.toggle('bad',!!(s.overflow||s.malformed||s.droppedEvents||r.metadata.transportGaps?.length||Object.values(r.metadata.receiverErrors||{}).some(v=>v)));
  }
  fullRange(){if(!this.result)return;$('sw-from').value=0;$('sw-to').value=Math.max(0,this.result.pcSamples.length-1);$('sw-filter').value='';}
  renderRange(){if(!this.result)return;const max=Math.max(0,this.result.pcSamples.length-1);this.from=Math.max(0,Math.min(max,Number($('sw-from').value)||0));this.to=Math.max(this.from,Math.min(max,Number($('sw-to').value)||0));$('sw-from').value=this.from;$('sw-to').value=this.to;this.selection=selectRange(this.result,this.from,this.to,$('sw-filter').value);this.page=0;this.renderRows();this.renderHot();this.draw();const width=this.to-this.from+1,total=max+1;this.zoomControls?.setDisabled({zoomIn:width<=2,zoomOut:width>=total,fit:width>=total});$('sw-edges').textContent='当前区间的相邻采样跳转（不是调用关系）：'+this.selection.transitions.slice(0,6).map(e=>`${e.from} → ${e.to} (${e.count})`).join(' · ');if(this.result.pcSamples.length&&(this.cursor<this.from||this.cursor>this.to))this.action(()=>this.selectSample(this.cursor<this.from?this.from:this.to));}
  zoomChart(zoomIn){if(!this.result?.pcSamples.length)return;const total={start:0,end:this.result.pcSamples.length-1},range={start:this.from??0,end:this.to??total.end},next=zoomRangeAroundCursor(range,total,this.cursor,zoomIn);if(next.start===range.start&&next.end===range.end)return;$('sw-from').value=next.start;$('sw-to').value=next.end;this.renderRange();}
  fitChart(){if(!this.result?.pcSamples.length)return;$('sw-from').value=0;$('sw-to').value=this.result.pcSamples.length-1;this.renderRange();}
  chartSampleAt(clientX){const canvas=$('sw-chart'),layout=this.chartLayout;if(!layout||!this.result?.pcSamples.length)return null;const x=Math.max(layout.left,Math.min(layout.left+layout.plotWidth,clientX-canvas.getBoundingClientRect().left)),fraction=(x-layout.left)/layout.plotWidth;return Math.max(this.from,Math.min(this.to,Math.round(this.from+fraction*(this.to-this.from))));}
  chartPointerDown(event){if(event.button!==0||!this.result?.pcSamples.length||!this.chartLayout)return;const x=event.clientX-$('sw-chart').getBoundingClientRect().left;if(x<this.chartLayout.left||x>this.chartLayout.left+this.chartLayout.plotWidth)return;event.preventDefault();this.chartDrag={startX:x,currentX:x,pointerId:event.pointerId};$('sw-chart').setPointerCapture(event.pointerId);this.draw();}
  chartPointerMove(event){const canvas=$('sw-chart');if(this.chartDrag){this.chartDrag.currentX=event.clientX-canvas.getBoundingClientRect().left;this.draw();return;}const sample=this.chartSampleAt(event.clientX);canvas.title=sample===null?'':`PC 样本 #${sample} · 点击定位，拖动选择区间；缩放以当前光标为中心`+(this.cursor>=this.from&&this.cursor<=this.to?` · 当前光标 #${this.cursor}`:'');}
  chartPointerUp(event){if(!this.chartDrag)return;const drag=this.chartDrag;this.chartDrag=null;const canvas=$('sw-chart');if(canvas.hasPointerCapture(event.pointerId))canvas.releasePointerCapture(event.pointerId);const endX=event.clientX-canvas.getBoundingClientRect().left;if(Math.abs(endX-drag.startX)>4&&this.chartLayout){const first=Math.min(drag.startX,endX)-this.chartLayout.left,last=Math.max(drag.startX,endX)-this.chartLayout.left,range=sampleRangeFromPixels(first,last,this.chartLayout.plotWidth,this.from,this.to);$('sw-from').value=range.start;$('sw-to').value=range.end;this.renderRange();}else{const sample=this.chartSampleAt(event.clientX);if(sample!==null)this.action(()=>this.selectSample(sample));}this.draw();}
  renderRows(){const rows=this.selection?.rows||[],total=Math.max(1,Math.ceil(rows.length/100));this.page=Math.max(0,Math.min(this.page,total-1));$('sw-page-info').textContent=`${rows.length} 条事件 · ${this.page+1}/${total} 页`;$('sw-page-prev').disabled=this.page===0;$('sw-page-next').disabled=this.page>=total-1;$('sw-rows').replaceChildren();
    for(const e of rows.slice(this.page*100,this.page*100+100)){const tr=document.createElement('tr');tr.className=(e.kind==='gap'?'sw-gap':'')+(e.kind==='pc'&&e.sample===this.cursor?' sw-selected':'');
      const label=e.kind==='pc'?`${hex(e.pc)} ${e.fn}`:e.kind==='exception'?`${e.exception===0?'线程':e.exception===15?'SysTick':e.exception===14?'PendSV':'异常 '+e.exception} ${e.action}`:e.kind==='itm'?`ITM #${e.port} ${hex(e.value)}`:e.reason||e.kind;
      const hz=this.recording.metadata.plan?.coreHz,t=e.cycles==null?'—':hz?`${(e.cycles/hz*1000).toFixed(3)} ms${e.timeQuality==='delayed'?' ≈':''} · 段${e.segment}`:`${e.cycles} cyc · 段${e.segment}`;
      tr.innerHTML=`<td>E#${e.index} / PC#${e.sample}</td><td>${esc(t)}</td><td>${esc(label)}</td><td>${esc(e.location?e.location.file.split('/').pop()+':'+e.location.line:'—')}</td>`;
      if(e.kind==='pc'){tr.tabIndex=0;tr.addEventListener('click',()=>this.action(()=>this.selectSample(e.sample)));tr.addEventListener('keydown',v=>{if(v.key==='Enter')this.action(()=>this.selectSample(e.sample));});} $('sw-rows').append(tr);
    }
  }
  renderHot(){$('sw-hot').replaceChildren();for(const h of (this.selection?.counts||[]).slice(0,40)){const b=document.createElement('button');b.className='sw-hot-row';b.style.setProperty('--hot',color(h.fn));b.textContent=`${h.fn} · ${h.count} (${(100*h.count/Math.max(1,this.selection.samples)).toFixed(1)}%)`;b.addEventListener('click',()=>{const e=this.selection.rows.find(x=>x.kind==='pc'&&x.fn===h.fn);if(e)this.action(()=>this.selectSample(e.sample));});$('sw-hot').append(b);}}
  draw(){const canvas=$('sw-chart'),r=this.result;if(!r||!canvas.clientWidth)return;const width=canvas.clientWidth,height=canvas.clientHeight,dpr=devicePixelRatio||1;canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);const c=canvas.getContext('2d');c.setTransform(dpr,0,0,dpr,0,0);c.fillStyle='#0d1117';c.fillRect(0,0,width,height);
    const names=this.selection?.counts.slice(0,7).map(x=>x.fn)||[],lanes=[...names,'其他 / 间隙'],left=130,right=12,top=22,step=(height-42)/lanes.length,plotWidth=Math.max(1,width-left-right),x=i=>left+(i-this.from)/Math.max(1,this.to-this.from)*plotWidth;this.chartLayout={left,right,top,height,width,plotWidth};
    c.font='11px monospace';c.fillStyle='#8b949e';c.fillText(`PC 样本 #${this.from} → #${this.to} · 不等同于时长`,left,13);
    lanes.forEach((name,i)=>{const y=top+i*step;c.strokeStyle='#242c35';c.beginPath();c.moveTo(left,y+step-3);c.lineTo(width-right,y+step-3);c.stroke();c.fillStyle='#aeb8c4';c.fillText(name.length>16?name.slice(0,15)+'…':name,4,y+step*.6);});
    const filter=$('sw-filter').value.toLowerCase();for(const run of r.runs){if(filter&&!run.fn.toLowerCase().includes(filter))continue;if(run.end<this.from||run.start>this.to)continue;const row=Math.max(0,names.includes(run.fn)?names.indexOf(run.fn):lanes.length-1);c.fillStyle=color(run.fn);const a=x(Math.max(this.from,run.start)),b=x(Math.min(this.to,run.end));c.fillRect(a,top+row*step+2,Math.max(.8,b-a),Math.max(3,step-7));}
    for(const e of r.events){if(e.sample<this.from||e.sample>this.to||e.kind!=='gap')continue;c.strokeStyle='#f85149';c.beginPath();c.moveTo(x(e.sample),top);c.lineTo(x(e.sample),height-12);c.stroke();}
    if(this.cursor>=this.from&&this.cursor<=this.to){c.strokeStyle='#fff';c.lineWidth=1.5;c.beginPath();c.moveTo(x(this.cursor),top);c.lineTo(x(this.cursor),height-12);c.stroke();}
    if(this.chartDrag){const a=Math.max(left,Math.min(this.chartDrag.startX,this.chartDrag.currentX)),b=Math.min(left+plotWidth,Math.max(this.chartDrag.startX,this.chartDrag.currentX));c.fillStyle='#58a6ff33';c.strokeStyle='#58a6ff';c.fillRect(a,top,b-a,height-top-12);c.strokeRect(a,top,b-a,height-top-12);}
  }
  async selectSample(index){const r=this.result;if(!r?.pcSamples.length)return;this.cursor=Math.max(0,Math.min(r.pcSamples.length-1,index));const e=r.pcSamples[this.cursor];$('sw-cursor').max=r.pcSamples.length-1;$('sw-cursor').value=this.cursor;$('sw-cursor-text').textContent=`PC #${this.cursor} ${hex(e.pc)} ${e.fn}`;const row=this.selection?.rows.findIndex(x=>x.kind==='pc'&&x.sample===this.cursor)??-1;if(row>=0){this.page=Math.floor(row/100);this.renderRows();const selected=$('sw-rows').querySelector('.sw-selected'),scroll=$('sw-rows').closest('.sw-table-scroll');if(selected&&scroll){const a=selected.getBoundingClientRect(),b=scroll.getBoundingClientRect();if(a.top<b.top)scroll.scrollTop+=a.top-b.top;else if(a.bottom>b.bottom)scroll.scrollTop+=a.bottom-b.bottom;}}this.draw();
    const id=++this._sourceId;$('sw-source-title').textContent=`${e.fn} · ${hex(e.pc)}`+(e.location?` · ${e.location.file}:${e.location.line}`:' · 无源码位置');
    if(!e.location?.line){$('sw-source').textContent='该 PC 没有可用的 DWARF 源码行；原始地址仍保留。';return;}
    try{const text=await this.sources.read(e.location.file);if(id!==this._sourceId)return;const lines=text.split(/\r?\n/),lo=Math.max(0,e.location.line-11),hi=Math.min(lines.length,e.location.line+12);$('sw-source').replaceChildren();for(let i=lo;i<hi;i++){const line=document.createElement('span');line.className=i+1===e.location.line?'sw-current-line':'';line.textContent=String(i+1).padStart(5)+'  '+lines[i]+'\n';$('sw-source').append(line);}}catch(error){if(id===this._sourceId)$('sw-source').textContent=error.message;}
  }
  async exportText(format){
    if(!this.recording||this.capture.active||this.exporting)return;
    const simple=format==='simple-c',extension=simple?'c':format,name=simple?'swo-simplified.c':'swo-execution.'+extension;
    if(simple&&!this.elf)throw Error('导出简化 .c 需要匹配的 ELF 和源码');
    // Start the picker synchronously within the click's user gesture.
    let handle;try{if(window.showSaveFilePicker)handle=await window.showSaveFilePicker({suggestedName:name,types:[{description:simple?'简化 SWO 源码轮廓':'完整 SWO 采样轨迹',accept:{'text/plain':['.'+extension]}}]});}catch(e){if(e.name==='AbortError')return;throw e;}
    this.exporting=true;this.renderCapture();let stream,worker,bytes=0,chunks=[],stats;
    const status=text=>$('sw-export-status').textContent=text;
    try{
      if(handle)stream=await handle.createWritable();
      const workerUrl=new URL('./export-worker.js',import.meta.url);
      workerUrl.searchParams.set('v',new URL(window.__webBundleUrl||location.href,location.href).searchParams.get('v')||String(Date.now()));
      worker=new Worker(workerUrl,{type:'module'});
      await new Promise((resolve,reject)=>{
        worker.onerror=e=>reject(Error(e.message));
        worker.onmessage=async({data})=>{try{
          if(data.kind==='error')throw Error(data.error);
          if(data.kind==='sources'){
            if(simple&&!data.paths.length)throw Error('ELF 中没有可定位的源码行，无法导出简化 .c');
            status('正在读取轨迹涉及的源码…');const sources={};let sourceBytes=0,missing=0;
            for(const path of data.paths){try{const text=await this.sources.read(path);if(sourceBytes+text.length*2>32*1024*1024){missing++;continue;}sourceBytes+=text.length*2;sources[path]=text;}catch{missing++;}}
            this._exportMissing=missing;worker.postMessage({kind:'export',format,sources});
          }else if(data.kind==='chunk'){
            const part=new TextEncoder().encode(data.text);bytes+=part.length;
            if(stream)await stream.write(part);else{if(bytes>128*1024*1024)throw Error('浏览器下载缓存超过 128 MiB；请使用支持直接保存文件的 Chrome/Edge 导出完整记录');chunks.push(part);}
            status(`正在导出${simple?'简化代码':'完整轨迹'} · ${(bytes/1048576).toFixed(1)} MiB`);worker.postMessage({kind:'ack'});
          }else if(data.kind==='done'){stats=data.stats;resolve();}
        }catch(e){reject(e);}};
        worker.postMessage({kind:'prepare',raw:this.recording.raw,metadata:this.recording.metadata,elf:this.elf?.buffer||null});
      });
      if(stream)await stream.close();else download(new Blob(chunks),name,'text/plain;charset=utf-8');
      status(simple?`简化代码已导出 · ${stats.lines} 行 · ${stats.sections} 个函数片段 · 合并 ${stats.removed} 条重复源码行`+(stats.skipped?` · 跳过 ${stats.skipped} 条无 C 源码样本`:''):
        `完整轨迹已导出 · ${(bytes/1048576).toFixed(1)} MiB`+(this._exportMissing?` · ${this._exportMissing} 个源文件未提供，保留 PC/位置`:''));
    }catch(e){if(stream)await stream.abort().catch(()=>{});status('导出未完成：'+e.message);throw e;}
    finally{worker?.terminate();this.exporting=false;this.renderCapture();}
  }
  exportCsv(){if(!this.selection)return;const cell=v=>'"'+String(v??'').replaceAll('"','""')+'"';const out=[['event_index','event','pc_sample','segment','cycles','time_quality','pc','function','file','line','detail'].map(cell).join(',')];for(const e of this.selection.rows)out.push([e.index,e.kind,e.sample,e.segment,e.cycles,e.timeQuality,e.pc==null?'':hex(e.pc),e.fn,e.location?.file,e.location?.line,e.reason|| (e.kind==='itm'?`port ${e.port}: ${hex(e.value)}`:e.kind==='exception'?`exception ${e.exception} ${e.action}`:'')].map(cell).join(','));download('\ufeff'+out.join('\r\n'),'swo-range.csv','text/csv;charset=utf-8');}
  onShow(){this.refreshPorts().catch(e=>this.error(e));this.draw();}
  summary(){return {recording:this.capture.running,bytes:this.capture.bytes,analyzing:!!this.analyzing,samples:this.result?.stats.analyzedSamples||0,stats:this.result?.stats||null};}
}

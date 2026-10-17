import {integrityView,flameView} from './analysis-views.js';
import {bindFunctionTimeline} from './function-timeline.js';
import {createZoomControls} from './zoom-controls.js';
const $=id=>document.getElementById(id),n=v=>Number(v).toLocaleString('zh-CN'),hex=v=>'0x'+(v>>>0).toString(16).padStart(8,'0');
const make=(tag,text,cls='')=>{const e=document.createElement(tag);e.textContent=text??'';e.className=cls;return e;};
const eventLabel=e=>({1:'未同步边界（初始化或缺口）',2:'跟踪开启边界',3:'记录窗口结束',6:'该范围的执行路径不完整',7:'无法读取匹配代码镜像',8:'执行地址未知',9:'异常进入 · 编号 '+(e.payload??'未知'),10:'异常返回'})[e.type]||e.text;
const issueLabel=text=>text.replace('OCSD_GEN_TRC_ELEM_NO_SYNC','未同步边界').replace('OCSD_GEN_TRC_ELEM_TRACE_ON','跟踪开启边界').replace('OCSD_GEN_TRC_ELEM_ADDR_UNKNOWN','执行地址未知').replace('OCSD_GEN_TRC_ELEM_ADDR_NACC','代码镜像无法访问').replace('OCSD_GEN_TRC_ELEM_I_RANGE_NOPATH','范围内执行路径不完整');
export class HistoryView{
  constructor(api,onError){this.api=api;this.onError=onError;this.sid=null;this.result=null;this.view='instructions';this.offset=0;this.selected=null;this.selectedFunction=null;this.rows=[];this.sources=new Map();this.revision=0;this.selectRevision=0;this.range=null;this.rangeHistory=[];this.window=null;this.flameMode='timeline';this.flameSourceCollapsed=false;this.scopeBusy=false;this.timelineKey=null;this.timelineData=null;this.timelineCollapsed=false;this.flameZoomControls=null;
    this.timelineChart=bindFunctionTimeline($('execution-timeline-canvas'),{onRange:r=>this.setRange(r),onSelect:seq=>this.select(seq,true),onError});
    this.timelineZoom=createZoomControls({onZoomOut:()=>this.zoomRange(false).catch(onError),onZoomIn:()=>this.zoomRange(true).catch(onError),onFit:()=>this.setRange(null,true,this.selected).catch(onError)});$('execution-timeline-zoom').replaceChildren(this.timelineZoom.element);
    $('toggle-execution-timeline').onclick=()=>{this.timelineCollapsed=!this.timelineCollapsed;$('execution-timeline-body').hidden=this.timelineCollapsed;$('toggle-execution-timeline').textContent=this.timelineCollapsed?'展开轨迹图':'收起轨迹图';$('toggle-execution-timeline').setAttribute('aria-expanded',String(!this.timelineCollapsed));if(!this.timelineCollapsed)requestAnimationFrame(()=>this.timelineChart.redraw());};
    $('clear-scope').onclick=()=>this.setRange(null).catch(onError);
    for(const b of document.querySelectorAll('[data-view]'))b.onclick=()=>{this.view=b.dataset.view;this.offset=0;this.render().catch(onError);};
    let timer;$('search').oninput=()=>{clearTimeout(timer);timer=setTimeout(()=>{this.offset=0;this.render().catch(onError);},200);};
    $('hide-skipped').onchange=()=>{this.offset=0;this.render().catch(onError);};
    $('prev').onclick=()=>{this.offset=Math.max(0,this.offset-150);this.render().catch(onError);};
    $('next').onclick=()=>{this.offset+=150;this.render().catch(onError);};
    $('history-prev').onclick=()=>this.navigate(-1).catch(onError);$('history-next').onclick=()=>this.navigate(1).catch(onError);
    $('jump').onclick=()=>this.jump().catch(onError);$('jump-value').onkeydown=e=>{if(e.key==='Enter')this.jump().catch(onError);};
    $('toggle-stack').onclick=()=>{const hidden=!$('stack-panel').hidden;$('stack-panel').hidden=hidden;$('toggle-stack').setAttribute('aria-expanded',String(!hidden));};
    $('toggle-summary').onclick=()=>{const hidden=!$('summary-panel').hidden;$('summary-panel').hidden=hidden;$('toggle-summary').setAttribute('aria-expanded',String(!hidden));};
  }
  path(suffix){return 'browse/'+this.sid+'/'+suffix;}
  setLoading(loading){this.loading=loading;for(const id of ['history-prev','history-next','jump','nav-mode','search','hide-skipped','toggle-summary'])$(id).disabled=loading||!this.result;for(const b of document.querySelectorAll('[data-view]'))b.disabled=loading||!this.result;this.pagination(this.result?this.pageTotal||0:0,this.offset);}
  unload(sid=null){
    this.recordRevision=(this.recordRevision||0)+1;this.revision++;this.selectRevision++;
    this.sid=sid;this.result=null;this.range=null;this.rangeHistory=[];this.window=null;
    this.timelineKey=null;this.timelineData=null;this.selected=null;this.selectedFunction=null;
    this.offset=0;this.view='instructions';this.sources.clear();this.sourceDomFile=null;this.scopeBusy=false;this.rows=[];
    this.timelineChart.setData(null);$('execution-timeline-panel').hidden=true;
    $('analysis-panes').classList.remove('flame-layout','flame-source-collapsed');
    $('scope-state').hidden=$('clear-scope').hidden=true;
    $('source-name').textContent='';$('source-name').title='';$('source-location').textContent='';$('source-location').title='';$('metrics').textContent='';$('quality').textContent='';$('quality').classList.remove('warn');
    $('cursor-state').textContent='未选中历史位置';
  }
  async load(sid,name){this.unload(sid);const generation=this.recordRevision;$('search').value='';$('table-container').replaceChildren(make('div','正在准备可复用索引…','empty'));$('record-description').textContent=name||sid;
    $('source-code').textContent='载入当前记录中…';$('call-stack').textContent='等待当前记录';$('cursor-state').textContent='未选中历史位置';$('selected-instruction').textContent='';$('selected-instruction').title='';$('source-name').title='';$('source-location').textContent='';$('source-location').title='';
    this.setLoading(true);$('summary-content').replaceChildren();
    try{
    const revision=++this.revision;const r=await this.api(this.path('overview'));if(revision!==this.revision)return;
    this.result=r;document.querySelector('[data-view="packets"]').textContent=(r.protocol||'ETMv4')+' 包';$('record-description').textContent=(r.name||name||sid)+' · ELF '+r.elf.sha256.slice(0,12);
    $('records').title=$('record-description').textContent;
    $('metrics').textContent=n(r.summary.instructions)+' 路径 · '+n(r.quality.validPackets)+' 包 · '+r.summary.exceptions+' 中断';
    $('quality').textContent=`${r.targetVerified?'采集时镜像已核对':'未记录采集时镜像核对'} · 未知条件 ${r.quality.unknownExecution} 条 · 包问题 ${r.quality.packetIssues} · overflow ${r.quality.overflowPackets}`+(r.status.lastErrorCode?' · 解码器错误 '+r.status.lastErrorCode:'')+(r.quality.unprocessedBytes?' · 未处理 '+r.quality.unprocessedBytes+' 字节':'')+' · 捕获边界保留';
    if(r.recordError)$('quality').textContent+=' · 最近操作失败：'+r.recordError;
    if(r.quality.unaccountedBytes)$('quality').textContent+=' · 字节覆盖缺口 '+r.quality.unaccountedBytes;
    if(r.quality.overlapBytes)$('quality').textContent+=' · 字节覆盖重叠 '+r.quality.overlapBytes;
    if(r.quality.unsynchronizedBytes)$('quality').textContent+=' · 未同步 '+r.quality.unsynchronizedBytes+' 字节';
    if(r.quality.unknownSourceBytes)$('quality').textContent+=' · 未知源 '+r.quality.unknownSourceBytes+' 字节';
    if(r.captureStart&&!r.captureStart.entryRecovered)$('quality').textContent+=' · 所选起点未出现在恢复指令中（开头同步边界）';
    if(r.physical?.software_filter?.enabled)$('quality').textContent+=' · 软件滤波 ≤'+r.physical.software_filter.limit_ns+' ns（移除 '+Object.values(r.physical.software_filter.removed_transitions||{}).reduce((a,b)=>a+b,0)+' 个边沿；原始波形保留）';
    $('quality').title=$('quality').textContent;
    $('quality').classList.toggle('warn',!!r.status.lastErrorCode||!!r.quality.packetIssues||!!r.quality.unaccountedBytes||!!r.quality.overlapBytes||r.samplingValidation?.sensitive||!!r.recordError||!!(r.captureStart&&!r.captureStart.entryRecovered));
    $('summary-content').replaceChildren(integrityView(r));await this.render();if(generation!==this.recordRevision)return;if(r.firstSeq!==null)await this.select(r.firstSeq,false);
    }finally{if(generation===this.recordRevision)this.setLoading(false);}
  }
  table(headers){const t=document.createElement('table'),head=document.createElement('thead'),row=document.createElement('tr'),body=document.createElement('tbody');for(const h of headers)row.append(make('th',h));head.append(row);t.append(head,body);return [t,body];}
  async render(){if(!this.result)return;const revision=++this.revision;for(const b of document.querySelectorAll('[data-view]'))b.classList.toggle('active',b.dataset.view===this.view);$('analysis-panes').classList.toggle('flame-layout',this.view==='flame');$('analysis-panes').classList.toggle('flame-source-collapsed',this.view==='flame'&&this.flameSourceCollapsed);const search=$('search').value.trim().toLowerCase();
    $('scope-state').hidden=$('clear-scope').hidden=!this.range;$('scope-state').textContent=this.range?['packets','quality'].includes(this.view)?'包 / 完整性显示全记录':'区间 #'+this.range.start+'～#'+this.range.end:'';
    if(!await this.renderTimeline(revision,search)||revision!==this.revision)return;
    if((this.view==='flame'||this.range)&&!this.window){const p=new URLSearchParams();this.scopeParams(p);const window=await this.api(this.path('window?'+p));if(revision!==this.revision)return;this.window=window;}
    if(this.view==='flame'){
      const flame=flameView(this.result,fn=>{this.view='instructions';$('search').value=fn;this.offset=0;this.render().catch(this.onError);},
        {window:this.window,mode:this.flameMode,cursorSeq:this.selected,cursorFunction:this.selectedFunction,zoomBusy:this.scopeBusy,sourceCollapsed:this.flameSourceCollapsed,canBack:!!this.rangeHistory.length,onError:this.onError,onZoom:zoomIn=>this.zoomRange(zoomIn),
         onMode:mode=>{this.flameMode=mode;return this.render();},onToggleSource:()=>{this.flameSourceCollapsed=!this.flameSourceCollapsed;return this.render();},onRange:r=>this.setRange(r),onBack:()=>this.backRange(),onReset:()=>this.setRange(null,true,this.selected),onSelect:seq=>this.select(seq,false)});
      this.flameZoomControls=flame.zoomControls;$('table-container').replaceChildren(flame);
      this.pagination(0,0);return;
    }
    let data,headers;
    if(this.view==='instructions'||this.view==='packets'){
      const p=new URLSearchParams({view:this.view==='packets'?'packets':'events',offset:this.offset,limit:150,search,hideSkipped:$('hide-skipped').checked?'1':'0'});
      this.scopeParams(p);data=await this.api(this.path('page?'+p));headers=this.view==='packets'?['偏移','长度','包']:['序号','PC','机器码 / 指令','函数 / 源码'];
    }else if(this.view==='quality'){data=await this.api(this.path('issues?offset='+this.offset+'&limit=150'));data.offset=this.offset;headers=['区段','关联 ETM 偏移','状态 / 原因'];}
    else{const all=(this.view==='functions'?(this.range?this.window.analysis:this.result.analysis).functions:(this.range?this.window.analysis:this.result.analysis).hotspots).filter(r=>JSON.stringify(r).toLowerCase().includes(search));data={rows:all.slice(this.offset,this.offset+150),total:all.length,offset:this.offset};headers=this.view==='functions'?['函数','路径记录','实际调用','未知状态']:['函数 / 源码行','路径记录','未知状态'];}
    if(revision!==this.revision)return;this.rows=data.rows;this.offset=data.offset;this.pagination(data.total,this.offset);
    const [table,body]=this.table(headers);
    for(const row of data.rows){const tr=document.createElement('tr');
      if(this.view==='functions'){tr.append(make('td',row.function),make('td',n(row.instructions)),make('td',row.calls+(row.interruptEntries?' / IRQ '+row.interruptEntries:'')),make('td',row.unknownExecution));tr.onclick=()=>{this.view='instructions';$('search').value=row.function;this.offset=0;this.render().catch(this.onError);};tr.className='function-row';}
      else if(this.view==='hotspots'){tr.append(make('td',row.function+' :'+(row.line??'—')),make('td',n(row.records)),make('td',row.unknown));tr.onclick=()=>this.locatePC(row.pc).catch(this.onError);tr.className='function-row';}
      else if(this.view==='quality'){const packet=['packet','gap','overlap','decoder'].includes(row.category);tr.className='issue-row'+(packet?' packet-problem':'');tr.append(make('td',row.startSeq===null?(packet?'ETM 数据问题':'物理边界'):'#'+row.startSeq+(row.endSeq!==row.startSeq?'～'+row.endSeq:'')),make('td',row.offset??'—'),make('td',issueLabel(row.reason)+(row.bytes?' · '+row.bytes+' 字节':'')));if(row.startSeq!==null)tr.onclick=()=>this.select(row.startSeq,true).catch(this.onError);}
      else if(this.view==='packets'){tr.append(make('td',row.offset),make('td',row.size),make('td',row.text));tr.title=row.hex;}
      else{tr.dataset.seq=row.seq;tr.className=row.kind==='event'?'event':'instruction'+(row.executionState==='unknown'?' unknown':row.executed?'':' skipped');if(row.seq===this.selected)tr.classList.add('selected');
        if(row.kind==='event'){tr.append(make('td',row.seq));const td=make('td',eventLabel(row));td.colSpan=3;tr.append(td);tr.title=row.text;}else{tr.append(make('td',row.seq),make('td',hex(row.pc),'pc'),make('td',row.mnemonic+' '+row.operands,'asm'),make('td',row.function+(row.line?' :'+row.line:''),'fn'));tr.title=(row.executionReason||'')+' · '+(row.file||'');}
        tr.tabIndex=0;tr.onclick=()=>this.select(row.seq,false).catch(this.onError);tr.onkeydown=e=>{if(e.key==='Enter')tr.click();};
      }body.append(tr);
    }$('table-container').replaceChildren(table);$('table-container').scrollTop=0;
  }
  pagination(total,offset){this.pageTotal=total;$('filter-count').textContent=n(total)+' 条';$('page-label').textContent=total?`${Math.floor(offset/150)+1} / ${Math.ceil(total/150)}`:'—';$('prev').disabled=!!this.loading||!offset;$('next').disabled=!!this.loading||offset+150>=total;}
  async renderTimeline(revision,search){
    const panel=$('execution-timeline-panel'),visible=this.view==='instructions'&&!!this.result;panel.hidden=!visible;if(!visible)return true;
    const p=new URLSearchParams({search,hideSkipped:$('hide-skipped').checked?'1':'0'});this.scopeParams(p);const key=p.toString();
    if(key!==this.timelineKey){const data=await this.api(this.path('timeline?'+p));if(revision!==this.revision)return false;this.timelineData=data;this.timelineKey=key;}
    const data=this.timelineData;if(!data)return true;this.timelineChart.setData(data);this.timelineChart.setCursor(this.selected);
    const summary=data.summary,range=data.range;
    this.updateZoomControlState();
    $('execution-timeline-summary').textContent=`#${n(range.start)}～#${n(range.end)} · ${n(summary.executed)} 条已证实 · ${n(summary.unknown)} 条未知`+(summary.notTaken?` · ${n(summary.notTaken)} 条未成立`:'')+(summary.markers?` · ${n(summary.markers)} 个边界 / 中断${data.markers.length<summary.markers?`（图中合并为 ${n(data.markers.length)} 段）`:''}`:'');
    return true;
  }
  updateZoomControlState(){
    const setState=(controls,range)=>{if(!controls||!range)return;const width=range.end-range.start+1,totalWidth=range.totalEnd-range.totalStart+1;controls.setDisabled({zoomIn:this.scopeBusy||width<=2,zoomOut:this.scopeBusy||width>=totalWidth,fit:this.scopeBusy||width>=totalWidth});};
    setState(this.timelineZoom,this.timelineData?.range);setState(this.flameZoomControls,this.window?.range);
  }
  async zoomRange(zoomIn){
    if(!this.result)return;const totalStart=this.timelineData?.range.totalStart??0,totalEnd=this.timelineData?.range.totalEnd??Math.max(0,this.result.eventCount-1);
    const range=this.range||{start:totalStart,end:totalEnd},width=range.end-range.start+1,totalWidth=totalEnd-totalStart+1;
    if(zoomIn?width<=2:width>=totalWidth)return;
    const nextWidth=zoomIn?Math.max(2,Math.ceil(width/2)):Math.min(totalWidth,width*2),anchor=Number.isInteger(this.selected)&&this.selected>=range.start&&this.selected<=range.end?this.selected:Math.floor((range.start+range.end)/2);
    const start=Math.max(totalStart,Math.min(totalEnd-nextWidth+1,anchor-Math.floor((nextWidth-1)/2)));
    const end=start+nextWidth-1;if(start===totalStart&&end===totalEnd)await this.setRange(null,true,anchor);else await this.setRange({start,end},true,anchor);
  }
  scopeParams(p){if(this.range){p.set('fromSeq',this.range.start);p.set('toSeq',this.range.end);}return p;}
  async setRange(range,remember=true,focusSeq=null){
    if(!this.result||this.scopeBusy)return;const generation=this.recordRevision,selectionRevision=this.selectRevision;
    if(focusSeq===null)focusSeq=this.selected;
    if(range&&(!Number.isInteger(range.start)||!Number.isInteger(range.end)||range.start<0||range.end<range.start))throw Error('请输入有效的执行序号区间');
    if(remember&&range)this.rangeHistory.push(this.range?{...this.range}:null);if(!range&&remember)this.rangeHistory=[];
    this.scopeBusy=true;this.updateZoomControlState();try{this.range=range?{start:Math.min(range.start,Math.max(0,this.result.eventCount-1)),end:Math.min(range.end,Math.max(0,this.result.eventCount-1))}:null;this.window=null;this.timelineKey=null;this.timelineData=null;this.offset=0;
      await this.render();if(generation!==this.recordRevision||selectionRevision!==this.selectRevision)return;const first=this.range?this.window?.firstSeq:this.result.firstSeq;const keep=Number.isInteger(focusSeq)&&(!this.range||focusSeq>=this.range.start&&focusSeq<=this.range.end);const target=keep?focusSeq:first;if(target!=null)await this.select(target,false);
    }finally{if(generation===this.recordRevision){this.scopeBusy=false;this.updateZoomControlState();}}
  }
  async backRange(){if(!this.rangeHistory.length)return;const range=this.rangeHistory.pop();await this.setRange(range,false,this.selected);}
  async select(seq,reveal=false){if(!this.result)return;if(this.range&&(seq<this.range.start||seq>this.range.end))throw Error('该位置不在所选区间内，请先重置区间');const revision=++this.selectRevision;const detail=await this.api(this.path('event/'+seq));if(revision!==this.selectRevision)return;this.selected=seq;this.timelineChart.setCursor(seq);const e=detail.event;this.selectedFunction=e.function||null;
    if(reveal){this.view='instructions';$('search').value='';$('hide-skipped').checked=false;this.offset=Math.floor((seq-(this.range?.start||0))/150)*150;await this.render();if(revision!==this.selectRevision)return;}
    for(const row of $('table-container').querySelectorAll('[data-seq]'))row.classList.toggle('selected',Number(row.dataset.seq)===seq);
    if(reveal){const row=$('table-container').querySelector(`[data-seq="${seq}"]`);if(row){const a=row.getBoundingClientRect(),b=$('table-container').getBoundingClientRect();$('table-container').scrollTop+=a.top-b.top-Math.max(0,(b.height-a.height)/2);}}
    $('cursor-state').textContent=`#${seq}`+(e.pc!==undefined?' · '+hex(e.pc):' · 边界/异常事件');
    const instructionText=e.kind==='instruction'?`${e.bytes}  ${e.mnemonic} ${e.operands} · ${e.executionState==='unknown'?'执行状态未知':e.executed?'已证实执行':'条件未成立'}`:eventLabel(e);$('selected-instruction').textContent=instructionText;$('selected-instruction').title=instructionText;
    $('selected-instruction').classList.toggle('unknown',e.executionState==='unknown');
    $('stack-basis').textContent=detail.stackBasis;$('stack-panel').title=detail.stackBasis;const stack=$('call-stack');stack.replaceChildren();for(const [i,name]of detail.callPath.entries())stack.append(make('span',(i?'› ':'')+name,/未知|未证实/.test(name)?'stack-frame uncertain':'stack-frame'));
    if(!detail.callPath.length)stack.append(make('span','该事件没有可证实的历史调用栈','dim'));
    const sourceName=(e.file||'').split(/[\\/]/).pop()||(e.kind==='instruction'?'机器码 / 无源码行号':'事件 / 无源码位置'),sourceLocation=(e.function||'')+(e.line?' · 第 '+e.line+' 行':'');$('source-name').textContent=sourceName;$('source-name').title=e.file||sourceName;$('source-location').textContent=sourceLocation;$('source-location').title=sourceLocation;
    if(!e.file){
      this.sourceDomFile=null;
      const box=$('source-code');
      if(e.kind==='instruction'){
        box.replaceChildren(make('div',`${e.function||'该函数'} 的当前指令在 ELF 中没有 DWARF 文件/行号；选择源码目录无法补出缺失行号。可查看上方机器码，或定位相邻的带源码指令。`,'empty'));
        const tools=make('div',null,'row');
        for(const [direction,label] of [[-1,'上一处源码'],[1,'下一处源码']]){const button=make('button',label);button.onclick=()=>this.navigate(direction,'source').catch(this.onError);tools.append(button);}
        box.append(tools);
      }else box.textContent=e.text||'该事件没有源码位置。';
      if(this.view==='flame')await this.render();return;
    }
    if(!this.sources.has(e.file)){const source=await this.api(this.path('source?file='+encodeURIComponent(e.file)));if(revision!==this.selectRevision)return;this.sources.set(e.file,source.text);}
    const source=this.sources.get(e.file);if(!source){this.sourceDomFile=null;$('source-code').textContent='尚未载入配套源码，可在文件页选择目录。';if(this.view==='flame')await this.render();return;}
    const box=$('source-code');
    if(this.sourceDomFile!==e.file||this.sourceDomText!==source){
      const fragment=document.createDocumentFragment();source.split(/\r?\n/).forEach((text,i)=>{const line=make('div',null,'source-line');line.append(make('span',i+1,'line-number'),make('span',text||' ','line-text'));fragment.append(line);});box.replaceChildren(fragment);this.sourceDomFile=e.file;this.sourceDomText=source;
    }
    box.querySelector('.highlight')?.classList.remove('highlight');const active=box.children[e.line-1];if(active){active.classList.add('highlight');box.scrollTop=active.offsetTop-box.offsetTop-100;}if(this.view==='flame')await this.render();
  }
  async navigate(direction,mode=$('nav-mode').value){if(!this.result)return;const generation=this.recordRevision;const q=new URLSearchParams({seq:this.selected??0,direction,mode});this.scopeParams(q);const found=await this.api(this.path('navigate?'+q));if(generation!==this.recordRevision)return;if(found.seq===null){$('cursor-state').textContent='该方向已无符合条件的历史位置';return;}await this.select(found.seq,true);}
  async refreshSources(){this.sources.clear();this.sourceDomFile=null;if(this.selected!==null)await this.select(this.selected);}
  async locatePC(pc){const generation=this.recordRevision;const q=new URLSearchParams({seq:this.selected??-1,pc:'0x'+pc.toString(16)});this.scopeParams(q);const found=await this.api(this.path('navigate?'+q));if(generation!==this.recordRevision)return;if(found.seq===null)throw Error('记录中未找到该 PC');await this.select(found.seq,true);if(found.wrapped)$('cursor-state').textContent+=' · 已回到首个匹配';}
  async jump(){if(!this.result)throw Error('记录索引仍在载入，请稍候');const value=$('jump-value').value.trim();if(/^0x[0-9a-f]+$/i.test(value))return this.locatePC(Number(value));if(!/^\d+$/.test(value))throw Error('请输入历史序号或 0x 开头的 PC');return this.select(Number(value),true);}
}

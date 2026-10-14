import {rangeFromPixels,wheelRange} from './execution-window.js';
import {createZoomControls} from './zoom-controls.js';
import {traceSettingsText} from './trace-options.js';
const make=(tag,text,className='')=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;e.className=className;if(className.split(/\s+/).includes('hint')&&text!==undefined)e.title=String(text);return e;};
const n=value=>Number(value).toLocaleString('zh-CN');

export function integrityView(result){
  const q=result.quality,box=make('div',undefined,'integrity-panel'),title=make('h3','完整性分层核算');
  const rows=[['OpenCSD 输入',`${n(q.processedBytes)} 字节`],['包记录字节覆盖',`${n(q.accountedBytes)} 字节；重叠 ${q.overlapBytes}，遗漏 ${q.unaccountedBytes}`],['已识别包',`${n(q.validPackets)} 个`],['未同步 ETM 数据',`${n(q.unsynchronizedBytes)} 字节 / ${q.unsynchronizedRecords} 条占位记录`],['TPIU 同步前',`${q.initialPhysicalBytes??'未记录'} 字节`],['未知源 ID 数据',`${q.unknownSourceBytes??'未记录'} 字节`],['尾部不完整帧',`${q.trailingFrameBytes??'未记录'} 字节`],['执行状态未知',`${q.unknownExecution} 条指令记录`],['溢出 / 包问题',`${q.overflowPackets} / ${q.packetIssues}`],['首个恢复区间的 ETM 偏移',q.firstPathOffset??'无'],['周期计数元素',`${q.timing.cycleElements} 个（未生成逐指令时间轴）`]];
  const physical=result.physical;
  rows[0][0]='OpenCSD 已处理';rows.unshift(['ETM 原始输入',`${n(q.inputBytes??q.processedBytes)} 字节`],['未处理输入',`${n(q.unprocessedBytes??0)} 字节`]);
  if(physical){rows.push(['物理时钟段',`${physical.clock_runs?.length??1} 段`],['长时钟间隔',`${physical.clock_gaps?.length??0} 处`],['最小数据跳变距离',`${physical.min_data_transition_distance_ns?.toFixed(3)??'—'} ns`]);}
  const snapshot=result.targetSnapshot;
  rows.push(['尾部同步标记残片',`${q.trailingSyncBytes??0} 字节（保留为捕获边界）`]);
  rows.push(['ETM 选项（配置快照）',traceSettingsText(result.config||snapshot?.config)]);
  const filter=result.laFilter;
  if(filter?.channels){const active=filter.channels.filter(x=>x.enabled);rows.push(['LA 毛刺滤波快照',active.length?active.map(x=>`CH${x.channel} ≤${x.samples} 点 (${x.widthNs?.toFixed(1)??'—'} ns)`).join('；'):'全部关闭']);}
  else rows.push(['LA 毛刺滤波快照','未记录，不能由磁盘预设推断']);
  if(snapshot?.clocks){const c=snapshot.clocks;rows.push(['SWD 时钟回读',`CPU ${(c.coreHz/1e6).toFixed(3)} / TRACECLK ${(c.physicalTraceHz/1e6).toFixed(3)} MHz`]);}
  if(result.samplingValidation){const s=result.samplingValidation;rows.push(['采样相位检查',`${s.phases.length} 个位置 / ${s.distinctStreams} 种数据流`],['所选相位的稳定窗',`${s.stableWindow[0].toFixed(2)}～${s.stableWindow[1].toFixed(2)}，约 ${s.stableWindowNs.toFixed(2)} ns${s.sensitive?' · 余量不足':''}`]);}
  if(result.spiValidation){const v=result.spiValidation;rows.push(['直接分支落点核对',`${n(v.branchTransitionsChecked)} 次`],['完整 SPI 发送核对',`${v.closedSpiCalls} 次，每次 ${v.bytesPerClosedTransfer} 字节`]);}
  box.append(title);for(const [label,value]of rows){const row=make('div',undefined,'integrity-row');row.append(make('span',label),make('strong',String(value)));box.append(row);}
  box.append(make('p',q.basis,'hint'),make('p','未同步、采集前调用栈与缺口保留为未知。普通调用、尾跳转和中断进入分开计数；此报告不等于无丢失保证。','hint'));
  return box;
}

function aggregateFlameView(result,onFunction,selectedFunction=''){
  const box=make('div',undefined,'flame-panel'),heading=make('h3','调用路径火焰图'),note=make('p',result.analysis.weight+'。纵向按调用层级延展，可滚动查看。点击方块放大；可查看选中函数的执行流。'+(selectedFunction?' 蓝框标出当前光标所属函数。':''),'hint'),tools=make('div',undefined,'row'),reset=make('button','重置视图'),open=make('button','查看函数执行流'),label=make('span','全部路径','dim'),canvas=make('div');
  tools.append(reset,open,label);box.append(heading,note,tools,canvas);
  const namespace='http://www.w3.org/2000/svg',original=result.analysis.flame;let selected=original;
  const levels=node=>1+Math.max(0,...node.children.map(levels));
  function repaint(root){selected=root;label.textContent=root.name+' · '+n(root.value)+' 条';open.disabled=root===original||/未知|中断/.test(root.name);const svg=document.createElementNS(namespace,'svg'),height=levels(root)*29+12;svg.setAttribute('viewBox',`0 0 1000 ${height}`);svg.setAttribute('role','img');svg.setAttribute('aria-label','按路径指令记录数量加权的调用火焰图');svg.style.width='100%';
    function draw(node,x,depth,width,path){const group=document.createElementNS(namespace,'g'),rect=document.createElementNS(namespace,'rect'),text=document.createElementNS(namespace,'text'),title=document.createElementNS(namespace,'title'),y=height-(depth+1)*29;
      rect.setAttribute('x',x);rect.setAttribute('y',y);rect.setAttribute('width',Math.max(.2,width-1));rect.setAttribute('height',26);let hash=0;for(const c of node.name)hash=(hash*31+c.charCodeAt(0))|0;rect.setAttribute('fill',node.name.includes('未知')?'#c4ccd8':`hsl(${25+Math.abs(hash)%40} 78% ${58+depth%3*5}%)`);rect.setAttribute('rx',2);if(selectedFunction&&node.name===selectedFunction){rect.setAttribute('stroke','#58a6ff');rect.setAttribute('stroke-width','2');}
      title.textContent=path.concat(node.name).join(' → ')+'；包含 '+n(node.value)+' 条，自身 '+n(node.self)+' 条';text.setAttribute('x',x+5);text.setAttribute('y',y+17);text.setAttribute('fill','#403329');text.setAttribute('font-size',12);text.textContent=width>40?node.name.slice(0,Math.max(1,Math.floor((width-10)/7))):'';group.append(rect,text,title);group.setAttribute('role','button');group.setAttribute('tabindex','0');group.setAttribute('aria-label',`函数 ${node.name}，${node.value} 条路径记录`);group.style.cursor='pointer';group.onclick=()=>repaint(node);group.onkeydown=e=>{if(e.key==='Enter')repaint(node);};svg.append(group);let next=x;for(const child of [...node.children].sort((a,b)=>b.value-a.value)){const w=width*child.value/node.value;draw(child,next,depth+1,w,path.concat(node.name));next+=w;}
    }
    if(root.value)draw(root,0,0,1000,[]);canvas.replaceChildren(svg);
  }
  reset.onclick=()=>repaint(original);open.onclick=()=>onFunction(selected.name);repaint(original);box.append(make('p',`观测到普通调用 ${n(result.analysis.observedCalls)} 次。灰色为采集前或未证实的调用层级；中断单独成树。`,'hint'));return box;
}

export function flameView(result,onFunction,o={}){
  if(!o.window)return aggregateFlameView(result,onFunction,o.cursorFunction||'');
  const data=o.window,scope=data.range,box=make('div',null,'execution-chart'),toolbar=make('div',null,'row window-tools');
  const safe=fn=>{try{Promise.resolve(fn()).catch(o.onError);}catch(e){o.onError(e);}};
  const button=(text,fn)=>{const b=make('button',text);b.onclick=()=>safe(fn);return b;};
  const modes=make('div',null,'window-actions'),rangeTools=make('div',null,'window-range');
  const timeline=button('按执行顺序',()=>o.onMode('timeline')),aggregate=button('按调用权重',()=>o.onMode('aggregate'));
  timeline.classList.toggle('primary',o.mode!=='aggregate');aggregate.classList.toggle('primary',o.mode==='aggregate');
  const back=button('上一级',o.onBack);back.disabled=!o.canBack;
  const from=make('input'),to=make('input');from.type=to.type='number';from.value=scope.start;to.value=scope.end;
  from.setAttribute('aria-label','区间起点序号');to.setAttribute('aria-label','区间结束序号');from.min=to.min=scope.totalStart;from.max=to.max=scope.totalEnd;
  const width=scope.end-scope.start+1,totalWidth=scope.totalEnd-scope.totalStart+1;
  const zoom=createZoomControls({onZoomOut:()=>safe(()=>o.onZoom?.(false)),onZoomIn:()=>safe(()=>o.onZoom?.(true)),onFit:()=>safe(o.onReset)});
  zoom.setDisabled({zoomIn:o.zoomBusy||width<=2,zoomOut:o.zoomBusy||width>=totalWidth,fit:o.zoomBusy||width>=totalWidth});
  const sourceToggle=button(o.sourceCollapsed?'展开源码':'收起源码',o.onToggleSource);sourceToggle.setAttribute('aria-expanded',String(!o.sourceCollapsed));sourceToggle.title=o.sourceCollapsed?'展开源码对照窗格':'收起源码窗格，扩展火焰图';
  modes.append(timeline,aggregate,back);rangeTools.append(make('span','#'),from,make('span','～'),to,button('查看',()=>o.onRange({start:Number(from.value),end:Number(to.value)})));toolbar.append(modes,zoom.element,sourceToggle,rangeTools);
  box.zoomControls=zoom;box.append(toolbar,make('p',`#${scope.start}～#${scope.end} · 横轴为执行序号，当前没有逐指令时间戳。`,'hint'));
  if(o.mode==='aggregate'){box.append(aggregateFlameView({...result,analysis:data.analysis},onFunction,o.cursorFunction||''));return box;}
  box.append(make('p','拖选、缩放按钮或 Ctrl＋滚轮查看局部序号区间；纵向按实际调用深度延展，可滚动查看。灰色“多段调用”表示当前显示桶含多条路径，放大后可查看细节。','hint'));
  const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');
  const maxDepth=Math.max(1,...data.timeline.map(b=>b.path.length)),height=maxDepth*26+38;
  const unit=1000;svg.setAttribute('viewBox',`0 0 ${unit} ${height}`);svg.setAttribute('role','img');svg.setAttribute('aria-label','按执行先后排列的调用区间图，拖选缩放');svg.classList.add('execution-timeline');svg.style.touchAction='none';
  const span=scope.end-scope.start+1;
  const text=(x,y,value,color='#9aa4af')=>{const t=document.createElementNS(ns,'text');t.setAttribute('x',x);t.setAttribute('y',y);t.setAttribute('fill',color);t.setAttribute('font-size','11');t.textContent=value;svg.append(t);};
  for(let i=0;i<=4;i++){text(i*unit/4,height-7,'#'+Math.round(scope.start+(scope.end-scope.start)*i/4));svg.lastChild.setAttribute('text-anchor',i===4?'end':i===0?'start':'middle');}
  const frames=[],active=[];
  for(const b of data.timeline){
    b.path.forEach((name,depth)=>{let frame=active[depth];
      if(frame&&frame.name===name&&frame.endSeq+1===b.startSeq&&!frame.cutAfter&&!b.events.length){frame.endSeq=b.endSeq;frame.records+=b.records;frame.unknown+=b.unknown;}
      else{frame={name,depth,startSeq:b.startSeq,endSeq:b.endSeq,records:b.records,unknown:b.unknown,firstSeq:b.firstSeq,cutAfter:!!b.events.length};frames.push(frame);active[depth]=frame;}
    });active.length=b.path.length;
    if(b.events.length){const x=(b.startSeq-scope.start)/span*unit,w=(b.endSeq-b.startSeq+1)/span*unit,marker=document.createElementNS(ns,'rect'),title=document.createElementNS(ns,'title');marker.setAttribute('x',x);marker.setAttribute('y',height-29);marker.setAttribute('width',Math.max(1,w));marker.setAttribute('height',7);marker.setAttribute('fill','#d29922');title.textContent=b.events.map(e=>'#'+e.seq+' '+e.text).join('；');marker.append(title);svg.append(marker);}
  }
  for(const b of frames){const x=(b.startSeq-scope.start)/span*unit,w=Math.max(.4,(b.endSeq-b.startSeq+1)/span*unit),name=b.name,depth=b.depth;
    const g=document.createElementNS(ns,'g'),r=document.createElementNS(ns,'rect'),title=document.createElementNS(ns,'title');
    r.setAttribute('x',x);r.setAttribute('y',depth*26+2);r.setAttribute('width',Math.max(.3,w-.4));r.setAttribute('height',23);let hash=0;for(const c of name)hash=(hash*31+c.charCodeAt(0))|0;
    r.setAttribute('fill',/未知|多段/.test(name)?'#667484':`hsl(${25+Math.abs(hash)%45} 76% ${56+depth%3*5}%)`);title.textContent=name+` · #${b.startSeq}～#${b.endSeq} · ${b.records} 条路径 / ${b.unknown} 条状态未知`;
    g.append(r,title);g.setAttribute('role','button');g.setAttribute('tabindex','0');g.setAttribute('aria-label',name+' 执行区间 '+b.startSeq+' 到 '+b.endSeq);g.onkeydown=e=>{if(e.key==='Enter')safe(()=>o.onSelect(b.firstSeq));};svg.append(g);
    if(w>40)text(x+3,depth*26+18,name.slice(0,Math.floor((w-6)/7)),'#302d25');
  }
  if(Number.isInteger(o.cursorSeq)&&o.cursorSeq>=scope.start&&o.cursorSeq<=scope.end){
    const x=(o.cursorSeq-scope.start)/span*unit,line=document.createElementNS(ns,'line'),marker=document.createElementNS(ns,'path'),title=document.createElementNS(ns,'title');
    line.setAttribute('x1',x);line.setAttribute('x2',x);line.setAttribute('y1','1');line.setAttribute('y2',height-20);line.setAttribute('class','execution-cursor');line.setAttribute('pointer-events','none');
    marker.setAttribute('d',`M${x-5} 1h10l-5 7z`);marker.setAttribute('class','execution-cursor-marker');marker.setAttribute('pointer-events','none');title.textContent='当前光标 · #'+o.cursorSeq;line.append(title);svg.append(line,marker);
  }
  let drag=null;
  const overlay=document.createElementNS(ns,'rect');overlay.setAttribute('fill','#58a6ff33');overlay.setAttribute('stroke','#58a6ff');overlay.setAttribute('height',height-20);overlay.setAttribute('pointer-events','none');
  svg.onpointerdown=e=>{if(e.button!==0)return;e.preventDefault();const r=svg.getBoundingClientRect();drag={start:e.clientX-r.left,width:r.width,left:r.left};svg.setPointerCapture(e.pointerId);overlay.setAttribute('x',drag.start/r.width*unit);overlay.setAttribute('width',0);svg.append(overlay);};
  svg.onpointermove=e=>{if(!drag)return;const end=Math.max(0,Math.min(drag.width,e.clientX-drag.left));overlay.setAttribute('x',Math.min(drag.start,end)/drag.width*unit);overlay.setAttribute('width',Math.abs(drag.start-end)/drag.width*unit);};
  svg.onpointerup=e=>{if(!drag)return;const d=drag;drag=null;overlay.remove();svg.releasePointerCapture(e.pointerId);const end=e.clientX-d.left,r=rangeFromPixels(d.start,end,d.width,scope.start,scope.end);if(Math.abs(end-d.start)>4)safe(()=>o.onRange(r));else safe(()=>o.onSelect(r.start));};
  svg.onpointercancel=()=>{drag=null;overlay.remove();};
  svg.addEventListener('wheel',e=>{if(!e.ctrlKey)return;e.preventDefault();const r=svg.getBoundingClientRect(),focus=Number.isInteger(o.cursorSeq)&&o.cursorSeq>=scope.start&&o.cursorSeq<=scope.end?(o.cursorSeq-scope.start)/span:(e.clientX-r.left)/r.width;safe(()=>o.onRange(wheelRange(scope,{start:scope.totalStart,end:scope.totalEnd},focus,e.deltaY<0)));},{passive:false});
  box.append(svg,make('p',`当前区间 ${n(data.analysis.flame.value)} 条路径记录；汇总包含未成立条件和未知状态。图形宽度表示执行顺序跨度，不表示耗时。`,'hint'));return box;
}

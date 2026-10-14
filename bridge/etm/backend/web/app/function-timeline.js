import {rangeFromPixels,wheelRange} from './execution-window.js';

const number=value=>Number(value||0).toLocaleString('zh-CN');
const laneColor=lane=>{
  if(lane.kind==='unknown')return '#d29922';
  if(lane.kind==='not-taken')return '#667484';
  if(lane.kind==='other')return '#82909e';
  let hash=0;for(const c of lane.name)hash=(hash*31+c.charCodeAt(0))|0;
  return `hsl(${25+Math.abs(hash)%45},76%,62%)`;
};
const eventNames={1:'未同步边界',2:'跟踪开启',3:'采集窗口结束',6:'执行路径不完整',7:'代码镜像不可用',8:'执行地址未知',9:'中断进入',10:'中断返回'};

export function bindFunctionTimeline(canvas,{onRange,onSelect,onError}){
  let data=null,cursor=null,drag=null,hover=null;
  const context=canvas.getContext('2d');
  const safe=fn=>{try{Promise.resolve(fn()).catch(onError);}catch(error){onError(error);}};
  const frame=()=>{
    if(!data||canvas.hidden)return;
    const rect=canvas.getBoundingClientRect(),width=Math.max(300,rect.width),dpr=window.devicePixelRatio||1;
    const lanes=data.lanes||[],rowHeight=20,top=9,axisHeight=27,height=Math.max(74,top+lanes.length*rowHeight+axisHeight);
    const left=Math.min(190,Math.max(116,width*.2)),right=76,plotWidth=Math.max(1,width-left-right),plotBottom=top+lanes.length*rowHeight;
    canvas.style.height=height+'px';canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);context.setTransform(dpr,0,0,dpr,0,0);
    context.clearRect(0,0,width,height);context.fillStyle='#0d1117';context.fillRect(0,0,width,height);
    context.font='11px "Cascadia Mono",Consolas,monospace';context.textBaseline='middle';
    const range=data.range||{start:0,end:0},span=Math.max(1,range.end-range.start+1),bins=Math.max(1,data.binCount||1),binWidth=plotWidth/bins;
    for(let tick=0;tick<=4;tick++){
      const x=left+plotWidth*tick/4;context.strokeStyle='#28313b';context.lineWidth=1;context.beginPath();context.moveTo(x,top-3);context.lineTo(x,plotBottom);context.stroke();
      const seq=Math.round(range.start+(range.end-range.start)*tick/4);context.fillStyle='#9aa4af';context.textAlign=tick===0?'left':tick===4?'right':'center';context.fillText('#'+number(seq),x,plotBottom+15);
    }
    context.textAlign='right';
    lanes.forEach((lane,index)=>{
      const y=top+index*rowHeight,max=Math.max(1,...lane.bins),base=laneColor(lane);
      context.fillStyle='#161b22';context.fillRect(left,y,plotWidth,rowHeight-1);
      context.fillStyle=base;context.fillText(lane.name.length>25?lane.name.slice(0,24)+'…':lane.name,left-8,y+8);
      const binsForLane=lane.bins||[];
      for(let i=0;i<binsForLane.length;i++){
        const amount=binsForLane[i];if(!amount)continue;
        const strength=.28+.72*Math.log1p(amount)/Math.log1p(max);
        context.globalAlpha=strength;context.fillRect(left+i*binWidth,y+2,Math.max(1,binWidth),rowHeight-5);
      }
      context.globalAlpha=1;context.textAlign='left';context.fillStyle='#9aa4af';context.fillText(number(lane.records),left+plotWidth+8,y+8);context.textAlign='right';
    });
    // ETM synchronization, incomplete-path, and exception elements remain visible as sequence markers.
    for(const marker of data.markers||[]){
      const x=left+(marker.seq-range.start)/span*plotWidth;if(x<left||x>left+plotWidth)continue;
      const types=Object.entries(marker.types||{[marker.type]:1}),single=types.length===1?Number(types[0][0]):null;
      context.strokeStyle=single===9||single===10?'#58a6ff':single===2?'#3fb950':types.length>1?'#bc8cff':'#f0883e';
      context.globalAlpha=.75;context.beginPath();context.moveTo(x,top-3);context.lineTo(x,plotBottom);context.stroke();context.globalAlpha=1;
    }
    if(cursor!==null&&cursor>=range.start&&cursor<=range.end){
      const x=left+(cursor-range.start)/span*plotWidth;context.strokeStyle='#f0f6fc';context.lineWidth=1.5;context.beginPath();context.moveTo(x,top-5);context.lineTo(x,plotBottom+2);context.stroke();
    }
    if(drag){const a=Math.min(drag.x,drag.current),b=Math.max(drag.x,drag.current);context.fillStyle='#58a6ff33';context.strokeStyle='#58a6ff';context.fillRect(a,top-4,b-a,plotBottom-top+7);context.strokeRect(a,top-4,b-a,plotBottom-top+7);}
    canvas.dataset.plotLeft=String(left);canvas.dataset.plotWidth=String(plotWidth);canvas.dataset.top=String(top);canvas.dataset.bottom=String(plotBottom);
    canvas.setAttribute('aria-valuemin',String(range.start));canvas.setAttribute('aria-valuemax',String(range.end));canvas.setAttribute('aria-valuenow',String(cursor??range.start));
  };
  const position=event=>{
    const rect=canvas.getBoundingClientRect(),x=Math.max(0,Math.min(rect.width,event.clientX-rect.left));
    const left=Number(canvas.dataset.plotLeft||0),plotWidth=Number(canvas.dataset.plotWidth||1),range=data?.range||{start:0,end:0};
    const pct=Math.max(0,Math.min(1,(x-left)/plotWidth));
    return {x,seq:Math.min(range.end,Math.max(range.start,range.start+Math.floor(pct*(range.end-range.start+1)))),pct,rect};
  };
  canvas.tabIndex=0;canvas.setAttribute('role','slider');canvas.setAttribute('aria-label','执行序号函数轨迹；左右键定位，拖动选择区间');canvas.style.touchAction='none';
  canvas.addEventListener('pointerdown',event=>{
    if(!data||event.button!==0)return;const p=position(event);if(p.x<Number(canvas.dataset.plotLeft||0))return;
    event.preventDefault();drag={x:p.x,current:p.x,startSeq:p.seq,start:p.pct,rect:p.rect};canvas.setPointerCapture(event.pointerId);frame();
  });
  canvas.addEventListener('pointermove',event=>{
    if(!data)return;const p=position(event);
    if(drag){drag.current=p.x;frame();return;}
    if(p.x<Number(canvas.dataset.plotLeft||0)){canvas.title='';return;}
    const index=Math.max(0,Math.min((data.binCount||1)-1,Math.floor(p.pct*(data.binCount||1))));
    const occupied=(data.lanes||[]).filter(lane=>lane.bins?.[index]).map(lane=>lane.name+' '+number(lane.bins[index])+' 条');
    const span=Math.max(1,data.range.end-data.range.start+1),marker=(data.markers||[]).map(item=>({item,distance:Math.abs(left+(item.seq-data.range.start)/span*plotWidth-p.x)})).filter(entry=>entry.distance<=8).sort((a,b)=>a.distance-b.distance)[0]?.item;
    const markerTypes=marker?.types||((marker?.type!==undefined)?{[marker.type]:1}:null);
    const markerDetail=marker&&markerTypes?Object.entries(markerTypes).map(([type,count])=>`${eventNames[type]||'ETM 事件'} ${number(count)} 个`).join('；'):'';
    canvas.title='#'+number(p.seq)+(occupied.length?' · '+occupied.join('；'):' · 当前分辨率下无路径记录')+(marker?` · #${number(marker.startSeq??marker.seq)}～#${number(marker.endSeq??marker.seq)} ${markerDetail}`:'');
  });
  canvas.addEventListener('pointerup',event=>{
    if(!drag)return;const state=drag,end=position(event),startX=state.x;drag=null;canvas.releasePointerCapture(event.pointerId);frame();
    if(Math.abs(end.x-startX)>4){
      const a=Math.min(state.start,end.pct)*(state.rect.width-Number(canvas.dataset.plotLeft||0)-76);
      const b=Math.max(state.start,end.pct)*(state.rect.width-Number(canvas.dataset.plotLeft||0)-76);
      safe(()=>onRange(rangeFromPixels(a,b,Math.max(1,state.rect.width-Number(canvas.dataset.plotLeft||0)-76),data.range.start,data.range.end)));
    }else safe(()=>onSelect(end.seq));
  });
  canvas.addEventListener('pointercancel',()=>{drag=null;frame();});
  canvas.addEventListener('wheel',event=>{
    if(!event.ctrlKey||!data)return;event.preventDefault();const p=position(event),range=data.range,total={start:range.totalStart,end:range.totalEnd};
    safe(()=>onRange(wheelRange(range,total,p.pct,event.deltaY<0)));
  },{passive:false});
  canvas.addEventListener('keydown',event=>{
    if(!data||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();
    const range=data.range;let next=cursor??range.start;
    if(event.key==='ArrowLeft')next=Math.max(range.start,next-1);if(event.key==='ArrowRight')next=Math.min(range.end,next+1);
    if(event.key==='Home')next=range.start;if(event.key==='End')next=range.end;safe(()=>onSelect(next));
  });
  const observer=new ResizeObserver(frame);observer.observe(canvas);
  return {setData(value){data=value;frame();},setCursor(value){cursor=value==null?null:Number(value);frame();},redraw:frame,
    destroy(){observer.disconnect();}};
}

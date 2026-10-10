import {SwoDecoder} from './decoder.js';
import {symbolIndex} from './analyze.js';
import {CodeOutline,codeLines} from './simplify.js';
const hex=v=>'0x'+(v>>>0).toString(16).padStart(8,'0');
const clean=v=>String(v??'').replaceAll('*/','* /').replace(/[\r\n\u0000]/g,' ');
function gaps(metadata,raw){return (metadata.transportGaps||[]).filter(g=>Number.isInteger(g.offset)&&g.offset>=0&&g.offset<=raw.length).sort((a,b)=>a.offset-b.offset);}
export function traceSourcePaths(raw,metadata,elf){
  if(!elf)return [];const symbols=symbolIndex(elf),paths=new Set(),d=new SwoDecoder({aligned:metadata.startAligned===true,emit:e=>{if(e.kind==='pc'){const p=symbols.lookup(e.pc).location?.file;if(p)paths.add(p);}}});
  let p=0;for(const g of gaps(metadata,raw)){d.feed(raw.subarray(p,g.offset));d.gap(String(g.reason));p=g.offset;}d.feed(raw.subarray(p));d.finish();return [...paths];
}
/** Re-decode the complete raw recording. No table/range/event-count cap. */
export function* traceTextChunks(raw,metadata={},elf=null,{format='c',sources={}}={}){
  if(format==='simple-c')return yield* traceSimpleCodeChunks(raw,metadata,elf,{sources});
  if(!['c','txt'].includes(format))throw Error('Unsupported trace export format');
  const symbols=elf?symbolIndex(elf):null,comment=text=>format==='c'?'/* '+clean(text)+' */\n':clean(text)+'\n';
  let text='',event=0,sample=0;const sourceCache=new Map();
  const lines=path=>{if(!sourceCache.has(path))sourceCache.set(path,typeof sources[path]==='string'?sources[path].split(/\r?\n/):null);return sourceCache.get(path);};
  yield comment('SWO PC 采样执行落点 · 完整原始记录解码 · '+raw.length+' bytes')+comment('本文件用于阅读，非可编译程序；相邻落点不是直接调用，未观测指令与分支不会被补齐。')+comment('段内周期来自 ITM 时间戳；未知/延迟时间明确保留，睡眠可能停止周期计数。')+comment('ELF SHA256: '+(metadata.elfSha256||'未保存'))+comment('参数: '+JSON.stringify(metadata.plan||{}))+comment('探针实际接收: '+JSON.stringify(metadata.receiver||{}))+comment('接收错误统计: '+JSON.stringify(metadata.receiverErrors||{}));
  const d=new SwoDecoder({aligned:metadata.startAligned===true,emit:e=>{
    const id=event++,time=e.cycles==null?'time=unknown':'cycles='+e.cycles+' ('+e.timeQuality+')',prefix='event='+id+' segment='+e.segment+' offset='+e.offset+' '+time;
    if(e.kind==='pc'){
      const s=symbols?.lookup(e.pc),where=s?.location,src=where&&lines(where.file)?.[where.line-1];
      text+=comment(prefix+' PC#'+sample+++' '+hex(e.pc)+' '+(s?.fn||'未载入 ELF')+' '+(where?where.file+':'+where.line:'无源码位置'));
      if(typeof src==='string')text+=src+'\n';else text+=comment('源码不可用；保留原始 PC');
    }else if(e.kind==='gap')text+=comment(prefix+' GAP: '+e.reason+'；后续为独立段，不跨缺口推断执行路径');
    else if(e.kind==='itm')text+=comment(prefix+' ITM port='+e.port+' value='+hex(e.value)+' size='+e.size);
    else if(e.kind==='exception')text+=comment(prefix+' EXCEPTION '+e.exception+' '+e.action);
    else text+=comment(prefix+' '+e.kind.toUpperCase()+(e.kind==='hardware'?' source='+e.source+' value='+hex(e.value):''));
  }});
  // Yield bounded chunks and let the worker wait for disk writes before continuing.
  let offset=0;for(const g of [...gaps(metadata,raw),{offset:raw.length,final:true}]){
    while(offset<g.offset){const end=Math.min(offset+16384,g.offset);d.feed(raw.subarray(offset,end));offset=end;if(text){yield text;text='';}}
    if(!g.final)d.gap('传输错误：'+String(g.reason));
  }
  const stats=d.finish();if(text)yield text;
  yield comment('END 完整解码事件='+event+' PC='+sample+' stats='+JSON.stringify(stats));
}

/** Source-only outline of all decoded PCs; do not invent lines or cross gaps. */
export function* traceSimpleCodeChunks(raw,metadata={},elf=null,{sources={}}={}){
  if(!elf)throw Error('导出简化 .c 需要匹配的 ELF 和源码');
  const symbols=symbolIndex(elf),cache=new Map();let text='',pcs=0,skipped=0,blank=0;
  const outline=new CodeOutline(line=>text+=line);
  const source=path=>{if(!cache.has(path))cache.set(path,typeof sources[path]==='string'?codeLines(sources[path],path):null);return cache.get(path);};
  const d=new SwoDecoder({aligned:metadata.startAligned===true,emit:e=>{
    if(e.kind==='gap'){outline.boundary();return;}if(e.kind!=='pc')return;pcs++;
    const where=symbols.lookup(e.pc).location,line=where&&source(where.file)?.[where.line-1];
    if(typeof line!=='string'){skipped++;outline.boundary();return;}
    if(!line.trim()){blank++;return;}
    outline.push(where.file+'\u0000'+where.line,line);
  }});
  let offset=0;for(const g of [...gaps(metadata,raw),{offset:raw.length,final:true}]){
    while(offset<g.offset){const end=Math.min(offset+16384,g.offset);d.feed(raw.subarray(offset,end));offset=end;if(text){yield text;text='';}}
    if(!g.final)d.gap('传输错误：'+String(g.reason));
  }
  d.finish();outline.flush();
  if(!outline.emitted)throw Error('没有可导出的源码行，请载入与 ELF 匹配的源码目录');
  if(text)yield text;
  return {pcs,skipped,blank,lines:outline.emitted,removed:outline.removed};
}

import {Elf} from '../elf/elf.js';
import {LineTable} from '../elf/lines.js';
import {SwoDecoder} from './decoder.js';
export function symbolIndex(buffer){
  const elf=new Elf(buffer),funcs=elf.symbols().filter(x=>x.isFunc&&x.size>0).map(x=>({...x,addr:(x.addr&~1)>>>0})).sort((a,b)=>a.addr-b.addr||a.size-b.size);
  let lines=null,note='';try{if(LineTable.available(elf))lines=LineTable.fromElf(elf);}catch(e){note='行号表解析失败：'+e.message;}
  const cache=new Map();
  function lookup(pc){if(cache.has(pc))return cache.get(pc);const addr=(pc&~1)>>>0;let lo=0,hi=funcs.length-1,i=-1;while(lo<=hi){const m=(lo+hi)>>1;if(funcs[m].addr<=addr){i=m;lo=m+1;}else hi=m-1;}
    const f=funcs[i],exact=!!f&&f.size>0&&addr<f.addr+f.size;
    const location=lines?.at(addr)||null,r={pc,fn:exact?f.name:'未知位置',funcAddr:exact?f.addr:null,location,exact};if(cache.size>=100000)cache.clear();cache.set(pc,r);return r;}
  return {lookup,elf,paths:lines?.paths||[],functionCount:funcs.length,note};
}
export function analyzeTrace(raw,metadata={},elfBuffer=null,{maxEvents=250000}={}){
  const symbols=elfBuffer?symbolIndex(elfBuffer):null,events=[],pcSamples=[],hot=new Map(),transitions=new Map(),runs=[];
  let droppedEvents=0,previous=null,sample=0,mapped=0;const lookup=pc=>symbols?.lookup(pc)||{pc,fn:'未载入 ELF',location:null,exact:false};
  const decoder=new SwoDecoder({aligned:metadata.startAligned===true,emit:e=>{
    if(events.length>=maxEvents){droppedEvents++;return;}
    const event={...e,index:events.length,sample};
    if(e.kind==='pc'){
      Object.assign(event,lookup(e.pc));event.sample=sample++;if(event.exact)mapped++;pcSamples.push(event);
      const key=event.fn;const h=hot.get(key)||{fn:key,count:0,firstPc:e.pc,location:event.location};h.count++;hot.set(key,h);
      const last=runs.at(-1);if(last?.fn===event.fn&&last.segment===e.segment){last.end=event.sample;last.count++;}else runs.push({fn:event.fn,start:event.sample,end:event.sample,count:1,segment:e.segment,pc:e.pc});
      if(previous&&previous.segment===e.segment&&previous.fn!==event.fn){const k=previous.fn+'\u0000'+event.fn;const edge=transitions.get(k)||{from:previous.fn,to:event.fn,count:0};edge.count++;transitions.set(k,edge);}previous=event;
    }else if(e.kind==='gap')previous=null;
    events.push(event);
  }});
  const gaps=(metadata.transportGaps||[]).filter(g=>Number.isInteger(g.offset)&&g.offset>=0&&g.offset<=raw.length).sort((a,b)=>a.offset-b.offset);
  let cursor=0;for(const g of gaps){decoder.feed(raw.subarray(cursor,g.offset));decoder.gap('传输错误：'+String(g.reason));cursor=g.offset;}decoder.feed(raw.subarray(cursor));const stats=decoder.finish();
  return {events,pcSamples,runs,hotspots:[...hot.values()].sort((a,b)=>b.count-a.count),transitions:[...transitions.values()].sort((a,b)=>b.count-a.count),stats:{...stats,mapped,analyzedSamples:sample,droppedEvents,unmapped:sample-mapped},paths:symbols?.paths||[],symbolNote:symbols?.note||'',functionCount:symbols?.functionCount||0,metadata};
}
export function selectRange(result,start=0,end=Infinity,filter=''){
  const q=filter.toLowerCase(),rows=result.events.filter(e=>e.sample>=start&&e.sample<=end&&(!q||(e.fn||e.kind).toLowerCase().includes(q)));
  const edges=new Map();let previous=null;for(const e of result.events){if(e.sample<start||e.sample>end)continue;if(e.kind==='gap'){previous=null;continue;}if(e.kind!=='pc')continue;if(q&&!e.fn.toLowerCase().includes(q)){previous=null;continue;}if(previous&&previous.segment===e.segment&&previous.fn!==e.fn){const k=previous.fn+'\u0000'+e.fn,v=edges.get(k)||{from:previous.fn,to:e.fn,count:0};v.count++;edges.set(k,v);}previous=e;}
  const counts=new Map();for(const e of rows)if(e.kind==='pc')counts.set(e.fn,(counts.get(e.fn)||0)+1);
  return {rows,transitions:[...edges.values()].sort((a,b)=>b.count-a.count),counts:[...counts].map(([fn,count])=>({fn,count})).sort((a,b)=>b.count-a.count),samples:rows.filter(e=>e.kind==='pc').length};
}

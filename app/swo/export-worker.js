import {sha256} from './recording.js';
const version=new URL(import.meta.url).searchParams.get('v');
const exporter=import(new URL('./export.js'+(version?'?v='+encodeURIComponent(version):''),import.meta.url));
let recording,ack;
self.onmessage=async({data})=>{
  if(data.kind==='ack'){ack?.();ack=null;return;}
  try{
    const {traceSourcePaths,traceTextChunks}=await exporter;
    if(data.kind==='prepare'){
      if(data.elf&&data.metadata?.elfSha256&&await sha256(data.elf)!==data.metadata.elfSha256)throw Error('ELF 指纹与记录不符，导出已停止');
      recording={raw:new Uint8Array(data.raw),metadata:data.metadata,elf:data.elf};
      self.postMessage({kind:'sources',paths:traceSourcePaths(recording.raw,recording.metadata,recording.elf)});
    }else if(data.kind==='export'){
      const iterator=traceTextChunks(recording.raw,recording.metadata,recording.elf,data);let stats;
      for(;;){
        const next=iterator.next();if(next.done){stats=next.value;break;}const text=next.value;
        const ready=new Promise(resolve=>ack=resolve);self.postMessage({kind:'chunk',text});await ready;
      }
      self.postMessage({kind:'done',stats});recording=null;
    }
  }catch(e){self.postMessage({kind:'error',error:e.message});}
};

import {traceSourcePaths,traceTextChunks} from './export.js';
import {sha256} from './recording.js';
let recording,ack;
self.onmessage=async({data})=>{
  if(data.kind==='ack'){ack?.();ack=null;return;}
  try{
    if(data.kind==='prepare'){
      if(data.elf&&data.metadata?.elfSha256&&await sha256(data.elf)!==data.metadata.elfSha256)throw Error('ELF 指纹与记录不符，导出已停止');
      recording={raw:new Uint8Array(data.raw),metadata:data.metadata,elf:data.elf};
      self.postMessage({kind:'sources',paths:traceSourcePaths(recording.raw,recording.metadata,recording.elf)});
    }else if(data.kind==='export'){
      for(const text of traceTextChunks(recording.raw,recording.metadata,recording.elf,data)){
        const ready=new Promise(resolve=>ack=resolve);self.postMessage({kind:'chunk',text});await ready;
      }
      self.postMessage({kind:'done'});recording=null;
    }
  }catch(e){self.postMessage({kind:'error',error:e.message});}
};

import {analyzeTrace} from './analyze.js';
import {sha256} from './recording.js';
self.onmessage=async({data})=>{
  try{
    if(data.elf&&data.metadata?.elfSha256&&await sha256(data.elf)!==data.metadata.elfSha256)throw Error('ELF 指纹与记录不符，请选择录制时的同一 ELF');
    const result=analyzeTrace(new Uint8Array(data.raw),data.metadata,data.elf);
    self.postMessage({id:data.id,result});
  }catch(e){self.postMessage({id:data.id,error:e.message});}
};

const MAGIC=new TextEncoder().encode('SWOPC01\n');
export const MAX_RAW=32*1024*1024,MAX_META=65536;
export function packRecording(raw,metadata={}){
  if(!(raw instanceof Uint8Array)||raw.length>MAX_RAW)throw Error('记录超过 32 MiB 限制');
  const header=new TextEncoder().encode(JSON.stringify({...metadata,format:'swo-pc-v1',rawBytes:raw.length}));
  if(header.length>MAX_META)throw Error('记录元数据过大');
  const out=new Uint8Array(12+header.length+raw.length);out.set(MAGIC);new DataView(out.buffer).setUint32(8,header.length,true);out.set(header,12);out.set(raw,12+header.length);return out;
}
export function unpackRecording(input){
  const b=input instanceof Uint8Array?input:new Uint8Array(input);
  if(!MAGIC.every((v,i)=>b[i]===v)){if(b.length>MAX_RAW)throw Error('原始 SWO 文件超过 32 MiB');return {raw:b,metadata:{format:'raw',startAligned:false}};}
  if(b.length<12)throw Error('记录文件头截断');
  const n=new DataView(b.buffer,b.byteOffset,b.byteLength).getUint32(8,true);
  if(n>MAX_META||12+n>b.length)throw Error('记录文件头长度无效');
  let metadata;try{metadata=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(b.subarray(12,12+n)));}catch{throw Error('记录元数据无法解析');}
  if(!metadata||metadata.format!=='swo-pc-v1')throw Error('记录格式版本不支持');
  const raw=b.subarray(12+n);if(raw.length>MAX_RAW||metadata.rawBytes!==raw.length)throw Error('记录字节数不匹配或超过限制');
  return {raw,metadata};
}
export async function sha256(bytes){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');}

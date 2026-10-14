/** ETM-only snapshot persistence; directory access/matching belongs to shared SourceStore. */
export async function readReferencedSources(store,references){
  const sources={},failed=[];
  for(const reference of [...new Set(references)]){
    try{sources[reference]=await store.read(reference);}
    catch(e){failed.push({reference,error:e.message});}
  }
  return {sources,failed};
}

export function sourceBatches(sources,maxBytes=4*1024*1024){
  const encoder=new TextEncoder(),batches=[];let batch={},bytes=0;
  for(const [name,text]of Object.entries(sources)){
    const size=encoder.encode(JSON.stringify({[name]:text})).length;
    if(bytes&&bytes+size>maxBytes){batches.push(batch);batch={};bytes=0;}
    batch[name]=text;bytes+=size;
  }
  if(bytes||!batches.length)batches.push(batch);
  return batches;
}

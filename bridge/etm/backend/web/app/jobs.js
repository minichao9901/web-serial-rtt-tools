/** Bounded local API requests and task polling. No target recovery/retry is implicit. */
export async function requestJson(url,options={}, {timeout=45000,fetchImpl=globalThis.fetch}={}){
  const controller=new AbortController();let timer;
  try{return await Promise.race([
    (async()=>{const response=await fetchImpl(url,{...options,signal:controller.signal});
      if(response.status===413)throw Error('提交内容超过本地服务容量限制；请按 ELF 匹配所需源码文件');
      let data;try{data=await response.json();}catch{throw Error('本地服务返回了无效响应，请检查桥连接');}
      if(!response.ok)throw Error(data.error||response.statusText);return data;})(),
    new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('本地服务请求超时，请检查桥连接；操作未自动重试'));},timeout);})
  ]);}finally{clearTimeout(timer);}
}

export async function pollJob(id,{read,onState=()=>{},onResume=null,onDone=()=>{},shouldResume=()=>true,
  sleep=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now,interval=200,totalMs=1800000,
  stageMs={queued:45000,starting:45000,armed:90000,saving:360000,decoding:900000}}){
  const started=now();let phase=null,phaseStarted=started,resumed=false;
  for(;;){
    const job=await read(id),time=now();
    if(!['queued','starting','armed','saving','decoding','done','cancelled','error'].includes(job.state))throw Error('采集服务返回未知任务状态：'+job.state);
    if(job.state!==phase){phase=job.state;phaseStarted=time;}
    await onState(job);
    if(job.state==='error'){const error=Error(job.error||'任务失败');error.job=job;throw error;}
    if(job.state==='cancelled')return job;
    if(job.state==='done'){await onDone(job);return job;}
    if(time-started>=totalMs||time-phaseStarted>=stageMs[phase])throw Error('任务停留在 '+phase+' 阶段过久，已结束等待；请检查桥与设备');
    if(phase==='armed'&&onResume&&!resumed){
      await sleep(100);
      // Stop may be clicked during the arm→resume delay. Never continue CPU after that request.
      if(shouldResume()){await onResume();resumed=true;}
    }
    await sleep(interval);
  }
}

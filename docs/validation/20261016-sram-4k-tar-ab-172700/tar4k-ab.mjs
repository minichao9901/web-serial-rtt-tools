import {Cdp,sleep} from '../../../tools/selftest/cdp-lib.mjs';import {writeFileSync} from 'node:fs';const c=new Cdp(undefined,180000),out=new URL('./',import.meta.url),runId='20261016-sram-4k-tar-ab-172700',lock='E:/web-etm-trace-coordination/hardware.lock',token=crypto.randomUUID();let locked=false;const report={runId,started:new Date().toISOString(),approach:'Experimental path sets TAR once per verified 4 KiB MEM-AP window, then transfers ordered DAP_TransferBlock chunks. It never pipelines across windows, so a later TAR write cannot disturb an earlier window.'};
try{
 await (await import('node:fs/promises')).mkdir(lock);locked=true;writeFileSync(`${lock}/owner.json`,JSON.stringify({owner:'codex-sram-4k-tar-ab',pid:process.pid,leaseToken:token,purpose:runId,started:new Date().toISOString()}));
 await c.connect();await c.send('Page.navigate',{url:'http://127.0.0.1:8899/index.html?modules=source&tar4k='+Date.now()+'#flash'});for(let i=0;i<150;i++){if(await c.eval('return !!window.__tools?.flash;').catch(()=>false))break;await sleep(100);}
 report.browser=await c.eval('return {entry:document.documentElement.dataset.bootEntry,usb:(await navigator.usb.getDevices()).map(d=>[d.vendorId,d.productId,d.serialNumber])};');
 report.result=await c.eval(`
const {WebUsbDapProbe:P}=await import('./app/rtt/dap-webusb.js');const {SramBenchTransfer,prepareSramClock}=await import('./app/flash/sram-transfer.js');const p=await P.open((await P.authorized())[0],{clockKhz:1000});let ram,regs,wasHalted,flashSha,finalResult={};
const sha=async b=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),x=>x.toString(16).padStart(2,'0')).join('');
try{
 wasHalted=!!((await p._readWord(0xe000edf0))&(1<<17));await p.halt();regs=[];for(let i=0;i<17;i++)regs.push(await p.regRead(i));ram=await p.readMemDiagnostic(0x20000000,65536);const r2=await p.readMemDiagnostic(0x20000000,65536);if(ram.some((v,i)=>v!==r2[i]))throw Error('RAM backup not stable');flashSha=await sha(await p.readMemDiagnostic(0x08000000,524288));
 const setup=await prepareSramClock(p,60000000),sz=await p.info(0xff),packet=sz[0]|sz[1]<<8,cnt=await p.info(0xfe),depth=Math.max(1,Math.min(4,cnt[0]||1)),maxWords=Math.min(253,Math.floor((packet-5)/4));if(packet!==1024||depth!==4)throw Error('unexpected advertised packet/depth '+packet+'/'+depth);
 const fast=async(addr,bytes,read)=>await p._withLock(async()=>{
   await p.flushWrites();const groups=[];for(let off=0;off<bytes.length;){const a=(addr+off)>>>0,windowBytes=Math.min(4096-(a&4095),bytes.length-off),nWords=windowBytes/4,frames=[];for(let word=0;word<nWords;){const n=Math.min(maxWords,nWords-word),start=off+word*4,req=new Uint8Array(5+(read?0:n*4));req[0]=6;req[1]=0;req[2]=n&255;req[3]=n>>>8;req[4]=read?15:13;if(!read)req.set(bytes.subarray(start,start+n*4),5);frames.push({req,start,n,read});word+=n;}groups.push({addr:a,frames});off+=windowBytes;}
   let serials=0,completed=[];
   for(const group of groups){
    await p._transfer([{ap:true,rnw:false,addr:4,data:group.addr}]);
    for(let i=0;i<group.frames.length;i+=depth){
      const slice=group.frames.slice(i,i+depth);
      // OUT commands are queued in order before IN responses are drained. This
      // preserves the shared MEM-AP TAR across chunks in the same 4 KiB window.
      const outs=[];
      for(const f of slice){const frame=new Uint8Array(p._framing==='pad'?packet:f.req.length);frame.set(f.req);if(frame.length>packet)throw Error('frame exceeds advertised limit');const r=await p.device.transferOut(p.epOut,frame);if(r.status!=='ok')throw Error('bulk OUT status');outs.push(r);}
      const ins=[];for(const f of slice){const r=await p.device.transferIn(p.epIn,packet);if(r.status!=='ok')throw Error('bulk IN status');ins.push(r);}
      for(let j=0;j<slice.length;j++){const v=ins[j].data,r=new Uint8Array(v.buffer,v.byteOffset,v.byteLength),f=slice[j];if(r[0]!==6||(r[1]|(r[2]<<8))!==f.n||r[3]!==1)throw Error('block response count/ACK mismatch '+Array.from(r.slice(0,4)));if(read){if(r.length<4+f.n*4)throw Error('short block read');bytes.set(r.subarray(4,4+f.n*4),f.start);}completed.push({group:serials,words:f.n});}
    }
    serials++;
   }
   p._posted=false;p.lastOkAt=Date.now();return {bytes,groups:serials,frames:completed.length};
 });
 const production=new SramBenchTransfer(p,depth,packet),pattern=n=>Uint8Array.from({length:20480},(_,i)=>((i*73)^(i>>>3)^(i>>>11)^(n*97))&255),rows=[];
 for(let round=0;round<8;round++)for(const mode of(round%2?['tar4k','page']:['page','tar4k'])){
   const data=pattern(round+1),start=performance.now();let writeMeta;
   if(mode==='page')await production.write(0x20000000,data);else writeMeta=(await fast(0x20000000,data,false));const writeMs=performance.now()-start;
   const verify=mode==='page'?await production.read(0x20000000,data.length):(await fast(0x20000000,new Uint8Array(data.length),true)).bytes;const writeDiff=verify.findIndex((v,i)=>v!==data[i]);if(writeDiff>=0)throw Error(mode+' write verify mismatch at '+writeDiff);
   const readBuf=new Uint8Array(data.length),t=performance.now();if(mode==='page')await production.read(0x20000000,data.length);else await fast(0x20000000,readBuf,true);const readMs=performance.now()-t;const readback=mode==='page'?await production.read(0x20000000,data.length):readBuf;const readDiff=readback.findIndex((v,i)=>v!==data[i]);if(readDiff>=0)throw Error(mode+' read verify mismatch at '+readDiff);
   rows.push({round,mode,writeMBps:20.48/(writeMs/1000),readMBps:20.48/(readMs/1000),writeMs,readMs,writeMeta});
 }
 const means={};for(const mode of ['page','tar4k']){const xs=rows.filter(x=>x.mode===mode);means[mode]={writeMBps:xs.reduce((s,x)=>s+x.writeMBps,0)/xs.length,readMBps:xs.reduce((s,x)=>s+x.readMBps,0)/xs.length};}
 finalResult={setup,packet,depth,maxWords,means,rows,tarWrapBytesMeasured:4096};
}catch(e){finalResult.testError=e.message;}finally{if(ram){try{await p.setClock(1000000);p.clockHz=1000000;await p.recoverDebugPort();await p.halt();await p.writeMem(0x20000000,ram);const r=await p.readMemDiagnostic(0x20000000,65536);if(r.some((v,i)=>v!==ram[i]))throw Error('RAM restore mismatch');const after=[];for(let i=0;i<17;i++)after.push(await p.regRead(i));if(JSON.stringify(after)!==JSON.stringify(regs))throw Error('register restore mismatch');const f=await p.readMemDiagnostic(0x08000000,524288);if(await sha(f)!==flashSha)throw Error('Flash changed');if(!wasHalted)await p.run();finalResult.restore={ramVerified:true,registersPreserved:true,flashUnchanged:true,cpuResumed:!wasHalted};}catch(e){finalResult.restoreError=e.message;}}await p.disconnect();}
return finalResult;`);
report.delta={writePercent:100*(report.result.means.tar4k.writeMBps/report.result.means.page.writeMBps-1),readPercent:100*(report.result.means.tar4k.readMBps/report.result.means.page.readMBps-1)};
report.passed=report.result.rows?.length===16&&report.result.restore?.ramVerified&&report.result.restore?.registersPreserved&&report.result.restore?.flashUnchanged;console.log(JSON.stringify({testError:report.result.testError,means:report.result.means,delta:report.delta,restore:report.result.restore,restoreError:report.result.restoreError},null,2));
}catch(e){report.error=e.stack;process.exitCode=1;console.error(e.stack);}finally{report.finished=new Date().toISOString();writeFileSync(new URL('tar4k-ab.json',out),JSON.stringify(report,null,2));c.close();if(locked){const fs=await import('node:fs/promises');const owner=JSON.parse(await fs.readFile(`${lock}/owner.json`,'utf8'));if(owner.leaseToken===token)await fs.rename(lock,lock.replace('hardware.lock','hardware.lock.released-'+runId));}}

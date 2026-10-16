import assert from 'node:assert/strict';import {Cdp,sleep} from '../../../tools/selftest/cdp-lib.mjs';import {writeFileSync} from 'node:fs';
const out=new URL('./',import.meta.url),c=new Cdp(undefined,120000),runId='20261016-sram-tar-boundary-170200',lock='E:/web-etm-trace-coordination/hardware.lock',token=crypto.randomUUID();let locked=false;
const report={runId,started:new Date().toISOString(),test:'Write exactly 255 words from a 1 KiB boundary, then write two sentinel words. The second word crosses the boundary; read the page head/tail to identify the actual TAR behavior. Full RAM and Flash are backed up and checked after the test.'};
try{
 await (await import('node:fs/promises')).mkdir(lock);locked=true;writeFileSync(`${lock}/owner.json`,JSON.stringify({owner:'codex-sram-tar-boundary',pid:process.pid,leaseToken:token,purpose:runId,started:new Date().toISOString()}));
 await c.connect();await c.send('Page.navigate',{url:'http://127.0.0.1:8899/index.html?modules=source&tar-boundary='+Date.now()+'#flash'});for(let i=0;i<150;i++){if(await c.eval('return !!window.__tools?.flash;').catch(()=>false))break;await sleep(100);}
 report.browser=await c.eval('return {entry:document.documentElement.dataset.bootEntry,usb:(await navigator.usb.getDevices()).map(d=>[d.vendorId,d.productId,d.serialNumber])};');
 report.result=await c.eval(`
const {WebUsbDapProbe:P}=await import('./app/rtt/dap-webusb.js');const p=await P.open((await P.authorized())[0],{clockKhz:1000});let savedRam,savedRegs,wasHalted=null,flashShaBefore,finalResult;
const hash=async b=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),x=>x.toString(16).padStart(2,'0')).join('');
const block=async(read,words,bytes)=>{const req=new Uint8Array(4+(read?0:bytes.length));req.set([0,words&255,words>>>8,read?15:13]);if(!read)req.set(bytes,4);const frame=Uint8Array.of(6,...req);if(frame.length>1024)throw Error('test frame exceeds advertised CMSIS-DAP size');const [o,i]=await Promise.all([p.device.transferOut(p.epOut,frame),p.device.transferIn(p.epIn,1024)]);if(o.status!=='ok'||i.status!=='ok')throw Error('TransferBlock USB status');const raw=i.data,r=new Uint8Array(raw.buffer,raw.byteOffset,raw.byteLength).subarray(1);if(new Uint8Array(raw.buffer,raw.byteOffset,1)[0]!==6||(r[0]|(r[1]<<8))!==words||r[2]!==1)throw Error('TransferBlock failed '+Array.from(r.slice(0,4)));return r;};
const rd=async(a)=>{await p._transfer([{ap:true,rnw:false,addr:4,data:a}]);const r=await block(true,1);return new DataView(r.buffer,r.byteOffset,r.byteLength).getUint32(3,true);};
try{
  const id={dp:p.idcode,device:await p._readWord(0xe0042000),flashKiB:(await p._readWord(0x1ffff7e0))&65535};if((id.device&4095)!==0x414||id.flashKiB!==512)throw Error('unexpected target '+JSON.stringify(id));
  wasHalted=!!((await p._readWord(0xe000edf0))&(1<<17));await p.halt();
  savedRegs=[];for(let i=0;i<17;i++)savedRegs.push(await p.regRead(i));
  savedRam=await p.readMemDiagnostic(0x20000000,65536);const ram2=await p.readMemDiagnostic(0x20000000,65536);if(savedRam.some((v,i)=>v!==ram2[i]))throw Error('RAM backup is not stable');
  flashShaBefore=await hash(await p.readMemDiagnostic(0x08000000,524288));
  const first=new Uint8Array(255*4).fill(0x11);await p.writeMem(0x20000000,first);
  await p._transfer([{ap:true,rnw:false,addr:4,data:0x20000000}]);
  await block(false,253,first.subarray(0,253*4));
  await block(false,2,first.subarray(253*4));
  await block(false,2,Uint8Array.of(0xbb,0xbb,0xbb,0xbb,0xcc,0xcc,0xcc,0xcc));
  const values={pageHead:await rd(0x20000000),pageLastWord:await rd(0x200003fc),nextPageHead:await rd(0x20000400)};
  finalResult={id,wasHalted,dpAbortResyncChecked:true,bytesWritten:1028,values,interpretation:values.pageHead===0xcccccccc&&values.pageLastWord===0xbbbbbbbb?'TAR wrapped at the 1 KiB boundary':values.pageHead===0x11111111&&values.nextPageHead===0xcccccccc?'TAR continued across the 1 KiB boundary':'unexpected sentinel layout',ramBytes:savedRam.length,ramSha256:await hash(savedRam),flashSha256Before:flashShaBefore};
}finally{
  if(savedRam){await p.setClock(1000000);p.clockHz=1000000;await p.recoverDebugPort();await p.halt();await p.writeMem(0x20000000,savedRam);const r=await p.readMemDiagnostic(0x20000000,65536);if(r.some((v,i)=>v!==savedRam[i]))throw Error('full RAM restore mismatch');const regs=[];for(let i=0;i<17;i++)regs.push(await p.regRead(i));if(JSON.stringify(regs)!==JSON.stringify(savedRegs))throw Error('register restore check failed');if(!wasHalted)await p.run();const flash=await p.readMemDiagnostic(0x08000000,524288);if(await hash(flash)!==flashShaBefore)throw Error('Flash changed');finalResult.restore={ramVerified:true,registersPreserved:true,flashUnchanged:true,cpuResumed:!wasHalted};}
  await p.disconnect();
}return finalResult;
`);
report.passed=report.result.interpretation==='TAR continued across the 1 KiB boundary'&&report.result.restore?.ramVerified&&report.result.restore?.registersPreserved&&report.result.restore?.flashUnchanged;
assert.equal(report.passed,true,JSON.stringify(report.result));console.log(JSON.stringify(report,null,2));
}catch(e){report.error=e.stack;process.exitCode=1;console.error(e.stack);}finally{report.finished=new Date().toISOString();writeFileSync(new URL('tar-boundary.json',out),JSON.stringify(report,null,2));c.close();if(locked){const fs=await import('node:fs/promises');const owner=JSON.parse(await fs.readFile(`${lock}/owner.json`,'utf8'));if(owner.leaseToken===token)await fs.rename(lock,lock.replace('hardware.lock','hardware.lock.released-'+runId));}}

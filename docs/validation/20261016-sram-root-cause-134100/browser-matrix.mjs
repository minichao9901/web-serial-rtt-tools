import {Cdp,sleep} from '../../../tools/selftest/cdp-lib.mjs';
import {writeFileSync} from 'node:fs';
const out=new URL('./',import.meta.url), c=new Cdp(undefined,120000);
const report={started:new Date().toISOString(),cases:[],errors:[]};
try{
 await c.connect();await c.send('Page.navigate',{url:'http://127.0.0.1:8899/index.html?rootcause='+Date.now()+'#flash'});
 for(let i=0;i<100;i++){if(await c.eval('return !!window.__tools?.flash;').catch(()=>false))break;await sleep(100);}
 await c.eval(`await __tools.probeManager.releaseOthers(null,'SRAM 根因对照');return true;`);
 for(const idle of [0,8])for(const depth of [1,4])for(const khz of [20000,36000,45000,60000]){
  const row=await c.eval(`const {WebUsbDapProbe:P}=await import('./app/rtt/dap-webusb.js');const {SramBenchTransfer:B}=await import('./app/flash/sram-transfer.js');let p;const r={idle:${idle},depth:${depth},khz:${khz},writes:[],reads:[]};try{p=await P.open((await P.authorized())[0],{clockKhz:1000});await p.halt();r.rcc=await p._readWord(0x40021004);r.csw=p.csw;r.initialId=p.idcode;await p._ctrl(4,Uint8Array.of(${idle},0xe8,3,0,0));const b=new B(p,${depth});p.verifyWrites=false;const src=new Uint8Array(20480);for(let i=0;i<src.length;i++)src[i]=((i*73)^(i>>>3)^123)&255;await b.write(0x20000000,src);await p.setClock(${khz}*1000);for(let n=0;n<3;n++){const t=performance.now();const got=await b.read(0x20000000,src.length);r.reads.push(performance.now()-t);if(got.some((v,i)=>v!==src[i]))throw Error('read mismatch');}for(let n=0;n<3;n++){for(let i=0;i<src.length;i++)src[i]^=(n+17);const t=performance.now();await b.write(0x20000000,src);r.writes.push(performance.now()-t);const got=await b.read(0x20000000,src.length);if(got.some((v,i)=>v!==src[i]))throw Error('write mismatch');}r.verified=true;}catch(e){r.error=e.message;}finally{if(p){try{await p.setClock(1000000);p.clockHz=1000000;await p.recoverDebugPort();await p.halt();}catch(e){r.cleanupError=e.message;}await p.disconnect();}}return r;`);
  if(row.reads.length)row.readMBps=.02048*row.reads.length/(row.reads.reduce((a,b)=>a+b,0)/1000);
  if(row.writes.length)row.writeMBps=.02048*row.writes.length/(row.writes.reduce((a,b)=>a+b,0)/1000);
  report.cases.push(row);writeFileSync(new URL('browser-matrix.json',out),JSON.stringify(report,null,2));console.log(JSON.stringify(row));
 }
}catch(e){report.error=e.stack;process.exitCode=1;}finally{report.finished=new Date().toISOString();writeFileSync(new URL('browser-matrix.json',out),JSON.stringify(report,null,2));c.close();}

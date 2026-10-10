/** HPM TX-only circular DMA -> probe SPI slave -> real WebSerial rate sweep. */
import {Cdp,sleep} from './cdp-lib.mjs';
import {mkdirSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
const args=process.argv.slice(2),arg=(n,d)=>args.find(a=>a.startsWith('--'+n+'='))?.split('=').slice(1).join('=')??d;
const rates=arg('rates','20000000,40000000,60000000,62500000,66666667,72000000,75000000,80000000,100000000,120000000').split(',').map(Number);
const seconds=Number(arg('seconds','3')),buffer=Number(arg('buffer','65536'));
const out=resolve(arg('out','docs/validation/2026-10-10-hpm-spi-rx-sweep.json'));
const c=new Cdp(process.env.CDP||'http://127.0.0.1:9333',60000),rows=[];
const snapshot=()=>c.eval(`const q=spiSweep;return {...Object.fromEntries(['bytes','frames','gaps','reverse','badFrames','bitErrors','comparedBits','unaligned'].map(k=>[k,q[k]])),time:performance.now(),status:await __tools.spiCdc.session.status()};`);
async function control(run,hz){
 return await c.eval(`const d=__tools.dbg,s=d.session;
 const write=async(name,v)=>{const p=d.sym.find(name);if(!p)throw Error(name);const b=new Uint8Array(4);new DataView(b.buffer).setUint32(0,v,true);await s.memWrite(p.addr,b);};
 await s.exclusive(async()=>{await write('g_spi_master_run',0);});
 await new Promise(r=>setTimeout(r,100));
 if(${run}){await s.exclusive(async()=>{await write('g_spi_master_request_hz',${hz||0});await write('g_spi_master_run',1);});await new Promise(r=>setTimeout(r,150));}
 return await s.exclusive(async()=>{const a={};for(const name of ['run','active','request_hz','clock_hz','sclk_hz','source_hz','clock_source','module_div','sclk_div','errors','refill_late','chunks','frames']){
 const p=d.sym.find('g_spi_master_'+name);const b=await s.memRead(p.addr,4);a[name]=new DataView(b.buffer,b.byteOffset,4).getUint32(0,true);}return a;});`);
}
try{
 await c.connect();await c.send('Page.navigate',{url:'http://127.0.0.1:8899/index.html?spi-sweep='+Date.now()+'#spicdc'});
 for(let i=0;i<100;i++){if(await c.eval('return !!__tools?.spiCdc').catch(()=>false))break;await sleep(100);}
 await c.eval(`const d=__tools.dbg;const b=await(await fetch('/tools/target-firmware/hpm5301evklite_spi_master/fw.elf?t='+Date.now())).arrayBuffer();d.loadElfBuffer(b,'hpm-spi-master.elf');
 const be=document.getElementById('d-backend');be.value='riscv';be.dispatchEvent(new Event('change'));await new Promise(r=>setTimeout(r,100));
 const t=document.getElementById('d-hpm-target');if(t){t.value='5301evklite';t.dispatchEvent(new Event('change'));}
 await d.connect();d._stopWatch();d.rttStop();if(d.session.halted)await d.session.cont();d._stopWatch();return true;`);
 const initial=await control(false,0);console.log('Target ready '+JSON.stringify(initial));
 await c.eval(`const s=__tools.spiCdc.session;await s.connect(false);await s.hid.xfer(0x35,Uint8Array.of(2));await new Promise(r=>setTimeout(r,100));
 globalThis.spiSweepOpen=SerialPort.prototype.open;SerialPort.prototype.open=function(o){return spiSweepOpen.call(this,{...o,bufferSize:${buffer}});};
 await __tools.spiCdc.stream.refreshPorts();await __tools.spiCdc.stream.connect();if(!__tools.session.isOpen)throw Error('CDC not open');
 globalThis.spiSweep={bytes:0,frames:0,gaps:0,reverse:0,badFrames:0,bitErrors:0,comparedBits:0,unaligned:0,last:null,tail:new Uint8Array()};
 const pop=x=>{x-=((x>>>1)&85);x=(x&51)+((x>>>2)&51);return (x+(x>>>4))&15;};
 __tools.session.on('data',b=>{const s=spiSweep;s.bytes+=b.length;const a=new Uint8Array(s.tail.length+b.length);a.set(s.tail);a.set(b,s.tail.length);let p=0;
 while(a.length-p>=64){if(a[p]!==83||a[p+1]!==80||a[p+2]!==73||a[p+3]!==67){s.unaligned++;p++;continue;}
 const seq=new DataView(a.buffer).getUint32(p+4,true),gap=s.last===null?0:(seq-s.last-1)>>>0;
 if(gap>1000000){s.reverse++;s.unaligned++;p++;continue;}
 let bits=0;for(let i=8;i<64;i++)bits+=pop(a[p+i]^(((seq+17*i)^90)&255));
 s.frames++;s.gaps+=gap;s.last=seq;s.comparedBits+=448;s.bitErrors+=bits;if(bits)s.badFrames++;p+=64;}
 s.tail=a.slice(p);});return true;`);
 for(const hz of rates){
  await c.eval(`spiSweep.last=null;spiSweep.tail=new Uint8Array();await __tools.spiCdc.session.start({mode:0,lsb:false});return true;`);
  const started=await control(true,hz);if(!started.active)throw Error('Target failed '+JSON.stringify(started));
  await sleep(500);const before=await snapshot();await sleep(seconds*1000);const after=await snapshot();
  const final=await control(false,0);await c.eval('await __tools.spiCdc.session.stop();return true;');
  const delta=Object.fromEntries(['bytes','frames','gaps','reverse','badFrames','bitErrors','comparedBits','unaligned'].map(k=>[k,after[k]-before[k]]));
  const probe=Object.fromEntries(['received','forwarded','dropped','fifoOverflows','dmaErrors'].map(k=>[k,after.status[k]-before.status[k]]));
  const aligned=!delta.gaps&&!delta.reverse&&!delta.unaligned;
  const row={requestedHz:hz,actualHz:started.sclk_hz,seconds:(after.time-before.time)/1000,MBps:delta.bytes/(after.time-before.time)/1000,serialBuffer:buffer,targetStart:started,targetStop:final,host:delta,probeWindow:probe,
   payloadBER:aligned&&delta.comparedBits?delta.bitErrors/delta.comparedBits:null,
   clean:!!delta.frames&&aligned&&!delta.badFrames&&!final.errors&&!final.refill_late&&!probe.dropped&&!probe.fifoOverflows&&!probe.dmaErrors};
  rows.push(row);mkdirSync(dirname(out),{recursive:true});writeFileSync(out,JSON.stringify({board:'HPM5301EVKLite',method:'32 KiB TX-only circular word DMA / held CS / changing SPIC sequence',at:new Date().toISOString(),rows},null,2));
  console.log(`${hz/1e6} -> ${row.actualHz/1e6} MHz ${row.MBps.toFixed(3)} MB/s ${row.clean?'PASS':'FAIL'} `+JSON.stringify({host:delta,probe,TXerrors:final.errors,late:final.refill_late}));
 }
}finally{
 try{await control(false,0);}catch{}
 try{await c.eval('await __tools.spiCdc.session.disconnect();await __tools.session.close();await __tools.dbg.disconnect();if(globalThis.spiSweepOpen)SerialPort.prototype.open=spiSweepOpen;return true;');}catch{}
 c.close();
}

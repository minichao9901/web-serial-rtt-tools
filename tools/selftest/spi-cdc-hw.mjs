/** Real browser SPI->CDC. Requires flashed F103 SPI fixture and granted probe. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {Cdp,sleep} from './cdp-lib.mjs';
const repo=process.env.PROBE_REPO||'E:/Share/github/akaLinkPro',base=process.env.CDP||'http://127.0.0.1:9333';
const c=new Cdp(base,30000),seconds=Number(process.env.SECONDS||10);
const h743=process.env.SPI_TARGET==='h743',mhz=Number(process.env.SPI_MHZ||40);
const hpmMaster=process.env.SPI_TARGET==='hpm5301-master';
if(hpmMaster){
 execFileSync(process.execPath,['tools/selftest/spi-cdc-hpm-sweep.mjs','--rates=20000000,40000000,60000000,80000000',`--seconds=${seconds}`,`--buffer=${process.env.SPI_SERIAL_BUFFER||65536}`,`--out=${process.env.SPI_RESULT||'tmp/hpm5301-spi-cdc-sweep.json'}`],{stdio:'inherit'});
 process.exit(0);
}
const serialBuffer=Number(process.env.SPI_SERIAL_BUFFER||4096);
assert.ok(Number.isInteger(serialBuffer)&&serialBuffer>0&&serialBuffer<=16*1024*1024);
function target(run,divider=h743?mhz:1,hello=false){
 if(hpmMaster)return {role:'HPM5301EVKLite SPI2 Master / DMA',g_spi_hz:10_000_000,automatic:true};
 const code=h743?'import sys,json;sys.path.insert(0,sys.argv[1]+"/script_test");from spi_cdc_h743_hw import target,symbols;print(json.dumps(target(symbols(),int(sys.argv[2]),int(sys.argv[3]))))':'import sys,json;sys.path.insert(0,sys.argv[1]+"/script_test");from spi_cdc_hw import target,symbols;print(json.dumps(target(symbols(),int(sys.argv[2]),int(sys.argv[3]),int(sys.argv[4]))))';
 return JSON.parse(execFileSync('py',['-c',code,repo,String(+run),String(divider),String(+!hello)],{encoding:'utf8',timeout:25000}));
}
try{
 await c.connect();await c.send('Page.navigate',{url:'http://127.0.0.1:8899/index.html?spi-hw='+Date.now()+'#spicdc'});
 for(let i=0;i<100;i++){if(await c.eval('return !!globalThis.__tools?.spiCdc?.stream?.rx').catch(()=>false))break;await sleep(50);}
 if(!hpmMaster)target(false);
 // Test-only A/B override; navigation discards it. Production uses its own default.
 if(serialBuffer!==4096)await c.eval(`globalThis.spiBenchSerialOpen=SerialPort.prototype.open;SerialPort.prototype.open=function(opts){return spiBenchSerialOpen.call(this,{...opts,bufferSize:${serialBuffer}});};`);
 await c.eval(`await __tools.spiCdc.session.connect(false);
   if(${hpmMaster}){
     // Retire any stale USB-SPI bridge descriptors from the preceding direct
     // master sweep before claiming the probe's shared SPI buffers as a slave.
     await __tools.spiCdc.session.hid.xfer(0x35,Uint8Array.of(2));
     await new Promise(r=>setTimeout(r,100));
   }
   await __tools.spiCdc.stream.refreshPorts();await __tools.spiCdc.stream.connect();
   if(!__tools.session.isOpen)throw Error('CDC permission/open failed');
   await __tools.spiCdc.session.start({mode:0,lsb:false});`);
 await c.eval(`
 const t=__tools;t.spiCdc.stream.rx.clear();t.spiCdc.stream.rxc.reset();
 globalThis.spiCheck={bytes:0,frames:0,gaps:0,badFrames:0,bitErrors:0,comparedBits:0,unalignedBytes:0,reversed:0,last:null,tail:new Uint8Array(),beats:0,maxGap:0,clock:performance.now()};
 const popcount=x=>{x&=255;x=x-((x>>>1)&0x55);x=(x&0x33)+((x>>>2)&0x33);return (x+(x>>>4))&0x0f;};
 spiCheck.timer=setInterval(()=>{const n=performance.now();spiCheck.maxGap=Math.max(spiCheck.maxGap,n-spiCheck.clock);spiCheck.clock=n;spiCheck.beats++;},20);
 t.session.on('data',b=>{
 const s=spiCheck;s.bytes+=b.length;const a=new Uint8Array(s.tail.length+b.length);a.set(s.tail);a.set(b,s.tail.length);let p=0;
 while(a.length-p>=64){if(a[p]!==83||a[p+1]!==80||a[p+2]!==73||a[p+3]!==67){s.unalignedBytes++;p++;continue;}
 const q=new DataView(a.buffer).getUint32(p+4,true);let frameBits=0;for(let i=8;i<64;i++)frameBits+=popcount(a[p+i]^(((q+17*i)^0x5a)&255));
 s.bitErrors+=frameBits;s.comparedBits+=448;if(frameBits)s.badFrames++;
 if(s.last!==null){const gap=(q-s.last-1)>>>0;if(gap<0x80000000)s.gaps+=gap;else s.reversed++;}s.last=q;s.frames++;p+=64;
 }s.tail=a.slice(p);
 });`);
 const clocks=target(true);await sleep(500);
 const before=await c.eval('return {bytes:spiCheck.bytes,frames:spiCheck.frames,gaps:spiCheck.gaps,badFrames:spiCheck.badFrames,bitErrors:spiCheck.bitErrors,comparedBits:spiCheck.comparedBits,unalignedBytes:spiCheck.unalignedBytes,reversed:spiCheck.reversed,time:performance.now(),status:await __tools.spiCdc.session.status()};');
 await sleep(seconds*1000);
 const after=await c.eval('const s=spiCheck;return {bytes:s.bytes,time:performance.now(),frames:s.frames,gaps:s.gaps,badFrames:s.badFrames,bitErrors:s.bitErrors,comparedBits:s.comparedBits,unalignedBytes:s.unalignedBytes,reversed:s.reversed,maxGap:s.maxGap,beats:s.beats,high:__tools.spiCdc.stream.suppressed,raw:__tools.spiCdc.stream.rx.bytes,chars:__tools.spiCdc.stream.rx.el.textContent.length,errors:__tools.errors,status:await __tools.spiCdc.session.status()};');
 const finalClocks=target(false);await sleep(100);await c.eval('clearInterval(spiCheck.timer);await __tools.spiCdc.session.stop();');
 const stopped=await c.eval('return {status:__tools.spiCdc.session.last,portOpen:__tools.session.isOpen};');
 const result={clocks,finalClocks,serialBuffer,seconds:(after.time-before.time)/1000,MBps:(after.bytes-before.bytes)/(after.time-before.time)/1000,
   payloadBitErrors:after.bitErrors-before.bitErrors,comparedBits:after.comparedBits-before.comparedBits,
   payloadBER:(after.bitErrors-before.bitErrors)/Math.max(1,after.comparedBits-before.comparedBits),before,after,stopped};
 mkdirSync('tmp',{recursive:true});writeFileSync(process.env.SPI_RESULT||'tmp/spi-cdc-hw-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
 assert.ok(result.MBps>(hpmMaster?0.1:h743?mhz/8*.95:2.1));
 assert.equal(clocks.g_spi_hz,hpmMaster?10_000_000:h743?mhz*1e6:18000000);
 if(!hpmMaster)assert.equal(finalClocks.g_refill_late,0);
 if(h743)assert.equal(finalClocks.g_dma_errors,0);
 for(const k of ['badFrames','gaps','reversed','unalignedBytes'])assert.equal(after[k]-(h743||hpmMaster?before[k]:0),0,k);
 assert.equal(result.payloadBitErrors,0,'payload BER');
 for(const k of ['dropped','fifoOverflows','dmaErrors'])assert.equal(after.status[k]-(h743||hpmMaster?before.status[k]:0),0,k);
 assert.ok(after.high&&after.raw<=2097152&&after.chars<=262144&&after.maxGap<500);assert.deepEqual(after.errors,[]);assert.ok(!stopped.status.running&&stopped.portOpen);
}finally{
 try{if(!hpmMaster)target(false);}catch{}
 try{await c.eval('if(globalThis.spiCheck)clearInterval(spiCheck.timer);await __tools.spiCdc.session.disconnect();await __tools.session.close();');}catch{}
 try{await c.eval('if(globalThis.spiBenchSerialOpen){SerialPort.prototype.open=spiBenchSerialOpen;delete globalThis.spiBenchSerialOpen;}');}catch{}
 c.close();
}

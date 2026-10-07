/** Real browser SPI->CDC. Requires flashed F103 SPI fixture and granted probe. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {Cdp,sleep} from './cdp-lib.mjs';
const repo=process.env.PROBE_REPO||'E:/Share/github/akaLinkPro',base=process.env.CDP||'http://127.0.0.1:9333';
const c=new Cdp(base,30000),seconds=Number(process.env.SECONDS||10);
function target(run,divider=1,hello=false){
 const code='import sys,json;sys.path.insert(0,sys.argv[1]+"/script_test");from spi_cdc_hw import target,symbols;print(json.dumps(target(symbols(),int(sys.argv[2]),int(sys.argv[3]),int(sys.argv[4]))))';
 return JSON.parse(execFileSync('py',['-c',code,repo,String(+run),String(divider),String(+!hello)],{encoding:'utf8',timeout:25000}));
}
try{
 await c.connect();await c.send('Page.navigate',{url:'http://127.0.0.1:8899/index.html?spi-hw='+Date.now()+'#spicdc'});
 for(let i=0;i<100;i++){if(await c.eval('return !!globalThis.__tools?.spiCdc?.stream?.rx').catch(()=>false))break;await sleep(50);}
 target(false);
 await c.eval(`await __tools.spiCdc.session.connect(false);await __tools.spiCdc.stream.refreshPorts();await __tools.spiCdc.stream.connect();if(!__tools.session.isOpen)throw Error('CDC permission/open failed');await __tools.spiCdc.session.start({mode:0,lsb:false});`);
 await c.eval(`
 const t=__tools;t.spiCdc.stream.rx.clear();t.spiCdc.stream.rxc.reset();
 globalThis.spiCheck={bytes:0,frames:0,gaps:0,bad:0,reversed:0,last:null,tail:new Uint8Array(),beats:0,maxGap:0,clock:performance.now()};
 spiCheck.timer=setInterval(()=>{const n=performance.now();spiCheck.maxGap=Math.max(spiCheck.maxGap,n-spiCheck.clock);spiCheck.clock=n;spiCheck.beats++;},20);
 t.session.on('data',b=>{
 const s=spiCheck;s.bytes+=b.length;const a=new Uint8Array(s.tail.length+b.length);a.set(s.tail);a.set(b,s.tail.length);let p=0;
 while(a.length-p>=64){if(a[p]!==83||a[p+1]!==80||a[p+2]!==73||a[p+3]!==67){s.bad++;p++;continue;}
 const q=new DataView(a.buffer).getUint32(p+4,true);let good=true;for(let i=8;i<64;i++)if(a[p+i]!==(((q+17*i)^0x5a)&255)){good=false;break;}
 if(!good){s.bad++;p++;continue;}if(s.last!==null){const gap=(q-s.last-1)>>>0;if(gap<0x80000000)s.gaps+=gap;else s.reversed++;}s.last=q;s.frames++;p+=64;
 }s.tail=a.slice(p);
 });`);
 const clocks=target(true);await sleep(500);
 const before=await c.eval('return {bytes:spiCheck.bytes,time:performance.now(),status:await __tools.spiCdc.session.status()};');
 await sleep(seconds*1000);
 const after=await c.eval('const s=spiCheck;return {bytes:s.bytes,time:performance.now(),frames:s.frames,gaps:s.gaps,bad:s.bad,reversed:s.reversed,maxGap:s.maxGap,beats:s.beats,high:__tools.spiCdc.stream.suppressed,raw:__tools.spiCdc.stream.rx.bytes,chars:__tools.spiCdc.stream.rx.el.textContent.length,errors:__tools.errors,status:await __tools.spiCdc.session.status()};');
 const finalClocks=target(false);await sleep(100);await c.eval('clearInterval(spiCheck.timer);await __tools.spiCdc.session.stop();');
 const stopped=await c.eval('return {status:__tools.spiCdc.session.last,portOpen:__tools.session.isOpen};');
 const result={clocks,finalClocks,seconds:(after.time-before.time)/1000,MBps:(after.bytes-before.bytes)/(after.time-before.time)/1000,before,after,stopped};
 mkdirSync('tmp',{recursive:true});writeFileSync('tmp/spi-cdc-hw-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
 assert.ok(result.MBps>2.1);assert.equal(clocks.g_spi_hz,18000000);assert.equal(finalClocks.g_refill_late,0);
 for(const k of ['bad','gaps','reversed'])assert.equal(after[k],0,k);
 for(const k of ['dropped','fifoOverflows','dmaErrors'])assert.equal(after.status[k],0,k);
 assert.ok(after.high&&after.raw<=2097152&&after.chars<=262144&&after.maxGap<500);assert.deepEqual(after.errors,[]);assert.ok(!stopped.status.running&&stopped.portOpen);
}finally{
 try{target(false);}catch{}
 try{await c.eval('if(globalThis.spiCheck)clearInterval(spiCheck.timer);await __tools.spiCdc.session.disconnect();await __tools.session.close();');}catch{}
 c.close();
}

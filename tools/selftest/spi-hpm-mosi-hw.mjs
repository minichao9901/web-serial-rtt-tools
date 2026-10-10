/** Probe SPI master TX-only -> target RX-only circular DMA, independently verified. */
import {Cdp,sleep,DEV_RE} from './cdp-lib.mjs';
import {F,T,linesToTcfg,xferPayload} from '../../app/spi/protocol.js';
import {mkdirSync,writeFileSync} from 'node:fs';import {dirname,resolve} from 'node:path';
const arg=(n,d)=>process.argv.find(x=>x.startsWith('--'+n+'='))?.split('=').slice(1).join('=')??d;
const rates=arg('rates','10,20,30,40,60').split(',').map(Number),cs=Number(arg('cs','0'));
const out=resolve(arg('out','docs/validation/2026-10-10-hpm-spi-mosi-sweep.json'));
const rows=[],c=new Cdp(process.env.CDP||'http://127.0.0.1:9333',60000);
async function target(reset=false,verify=false){return await c.eval(`const d=__tools.dbg,s=d.session;
 const write=async(n,v)=>{const p=d.sym.find(n);const b=new Uint8Array(4);new DataView(b.buffer).setUint32(0,v,true);await s.memWrite(p.addr,b);};
 if(${reset})await s.exclusive(async()=>{await write('g_rx_reset',1);});
 if(${verify})await s.exclusive(async()=>{await write('g_verify',1);});
 await new Promise(r=>setTimeout(r,100));
 return await s.exclusive(async()=>{const a={};for(const n of ['g_rx_ready','g_verified','g_rx_bytes','g_rx_laps','g_rx_errors','g_rx_fifo_errors','g_rx_bad_bytes','g_rx_bad_bits','g_rx_first_bad','g_rx_module_hz']){
 const b=await s.memRead(d.sym.find(n).addr,4);a[n]=new DataView(b.buffer,b.byteOffset,4).getUint32(0,true);}return a;});`);}
try{
 await c.connect();await c.send('Page.navigate',{url:'http://127.0.0.1:8899/index.html?mosi-bench='+Date.now()+'#spi'});
 for(let i=0;i<100;i++){if(await c.eval('return !!__tools?.spiSession').catch(()=>false))break;await sleep(100);}
 await c.eval(`const d=__tools.dbg;d.loadElfBuffer(await(await fetch('/tools/target-firmware/hpm5301evklite_spi_rx/fw.elf')).arrayBuffer(),'spi-rx.elf');
 const be=document.getElementById('d-backend');be.value='riscv';be.dispatchEvent(new Event('change'));await new Promise(r=>setTimeout(r,100));
 await d.connect();d._stopWatch();d.rttStop();if(d.session.halted)await d.session.cont();d._stopWatch();return true;`);
 await c.eval('document.getElementById("sp-connect").click();return true;',true);await c.settle(DEV_RE,'__tools.spiSession.connected',30000);
 await c.eval('document.getElementById("sp-usb").click();return true;',true);await c.settle(/akaLinkPro|CMSIS|WinUSB/i,'__tools.spiSession.dataReady',30000);
 for(const rate of rates){
  await c.eval(`const s=__tools.spiSession;await s.loadCfg({quiet:true});if(s.enabled)await s.setEnabled(false,'bus');
   await s.applyConfig({...s.cfg,sclkHz:${rate*1e6},mode:0,csPolicy:${cs},txDmaThreshold:100},'bus');await s.setEnabled(true,'bus');return true;`);
  const ready=await target(true,false);if(!ready.g_rx_ready)throw Error('Target RX not armed');
  const items=Array.from({length:128},(_,n)=>{const tx=Uint8Array.from({length:256},(_,i)=>(n*29+i*73+(i>>>1)*11)&255);return {type:T.XFER,flags:F.RSP,label:'RX #'+n,payload:[...xferPayload({tcfg:linesToTcfg(1),tx,rxLen:0})]};});
  const sent=await c.eval(`const s=__tools.spiSession;const items=${JSON.stringify(items)}.map(x=>({...x,payload:new Uint8Array(x.payload)}));
   const before=performance.now();const r=await s.sendFrames(items,{quiet:true,tag:'bus',timeoutMs:5000,batchBytes:32768});await s.pollStatus(true);
   return {sent:r.sent,failed:r.failed,replyErrors:r.rsps.filter(x=>!x||x.status).length,ms:performance.now()-before,counters:s.counters};`);
  const rx=await target(false,true);
  const row={requestedMHz:rate,actualHz:sent.counters.actualSclkHz,csPolicy:cs,bytes:32768,target:rx,probe:sent,
   bitErrorRatio:rx.g_rx_bytes===32768?rx.g_rx_bad_bits/(32768*8):null,
   clean:sent.failed===0&&sent.replyErrors===0&&rx.g_verified===1&&rx.g_rx_bytes===32768&&rx.g_rx_bad_bits===0&&rx.g_rx_errors===0&&rx.g_rx_fifo_errors===0};
  rows.push(row);mkdirSync(dirname(out),{recursive:true});writeFileSync(out,JSON.stringify({method:'Probe TX-only word DMA -> independent target RX-only byte circular DMA',at:new Date().toISOString(),rows},null,2));
  console.log(rate+' MHz '+(row.clean?'PASS':'FAIL')+' '+JSON.stringify({rx,probe:sent.counters,replyErrors:sent.replyErrors,hostMBps:32768/sent.ms/1000}));
 }
}finally{
 try{await c.eval(`const s=__tools.spiSession;if(s.enabled)await s.setEnabled(false,'bus');if(s.transport?.device)await s.transport.device.transferOut(s.transport.epOut,new Uint8Array());await s.disconnect();await __tools.dbg.disconnect();return true;`);}catch{}
 c.close();
}

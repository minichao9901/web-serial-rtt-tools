/** Read independent target RX DMA buffers after a probe-master echo test. */
import {Cdp,sleep} from './cdp-lib.mjs';
import {mkdirSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
const arg=(n,d)=>process.argv.find(x=>x.startsWith('--'+n+'='))?.split('=').slice(1).join('=')??d;
const rate=Number(arg('sync-rate','60')),frame=arg('last-frame',null);
const lastSeed=frame===null?0x1357a+rate*2:Number(frame),prevSeed=frame===null?0x13579+rate*2:Number(frame)-1;
const make=n=>Array.from({length:256},(_,i)=>(n*29+i*73+(i>>>1)*11)&255);
const c=new Cdp();let result;
try{
 await c.connect();await c.send('Page.navigate',{url:'http://127.0.0.1:8899/index.html#dbg'});
 for(let i=0;i<100;i++){if(await c.eval('return !!__tools?.dbg').catch(()=>false))break;await sleep(100);}
 result=await c.eval(`const d=__tools.dbg;d.loadElfBuffer(await(await fetch('/tools/target-firmware/hpm5301evklite_spi_dma/fw.elf')).arrayBuffer(),'spi-slave.elf');
 const be=document.getElementById('d-backend');be.value='riscv';be.dispatchEvent(new Event('change'));await new Promise(r=>setTimeout(r,100));
 await d.connect();d._stopWatch();await d.session.halt();
 const read32=async n=>{const p=d.sym.find(n);if(!p)throw Error(n);const b=await d.session.memRead(p.addr,4);return new DataView(b.buffer,b.byteOffset,4).getUint32(0,true);};
 const lastPtr=await read32('s_tx'),prevPtr=await read32('s_rx');
 return {frames:await read32('g_spi_frames'),errors:await read32('g_spi_errors'),moduleHz:await read32('g_spi_clock_hz'),
 lastPtr,prevPtr,lastRx:[...await d.session.memRead(lastPtr,256)],previousRx:[...await d.session.memRead(prevPtr,256)]};`);
 const compare=(got,seed)=>{const expected=make(seed),diff=[];for(let i=0;i<256;i++)if(got[i]!==expected[i])diff.push({offset:i,expected:expected[i],actual:got[i]});return {seed,match:!diff.length,mismatchedBytes:diff.length,firstDiff:diff.slice(0,12)};};
 result.lastComparison=compare(result.lastRx,lastSeed);result.previousComparison=compare(result.previousRx,prevSeed);
 result.at=new Date().toISOString();const out=resolve(arg('out','tmp/hpm-spi-inspect.json'));mkdirSync(dirname(out),{recursive:true});writeFileSync(out,JSON.stringify(result,null,2));
 console.log(JSON.stringify({...result,lastRx:result.lastRx.slice(0,16),previousRx:result.previousRx.slice(0,16)},null,2));
}finally{try{await c.eval('await __tools.dbg.disconnect();return true;');}catch{}c.close();}

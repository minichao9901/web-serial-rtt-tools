// Real WebUSB diagnostics: isolate SWD clock and count CMSIS-DAP round trips.
// Destructively tests 32KiB of unused H7B0 AXI SRAM, with complete readback.
import { Cdp } from './cdp-lib.mjs';
import { writeFile } from 'node:fs/promises';
const c=new Cdp();
const results=[];
try{
  await c.connect();
  for(const clockKhz of [1000,4000,20000,36000,45000,60000]){
    const r=await c.eval(`
      const {WebUsbDapProbe:P}=await import('./app/rtt/dap-webusb.js');
      const p=await P.open((await P.authorized())[0],{clockKhz:1000});
      let wasHalted;
      try{
        const state=await p.readMem(0xe000edf0,4);
        if(state.length!==4)throw new Error('CPU state read incomplete');
        wasHalted=!!(state[2]&2);
        await p.halt();
        if(!((await p.readMem(0xe000edf0,4))[2]&2))throw new Error('CPU did not halt');
        await p.setClock(${clockKhz}*1000);
        p.verifyWrites=false;
        const data=Uint8Array.from({length:32768},(_,i)=>((i*73)^(i>>>5)^${clockKhz})&255);
        const calls={};const ctrl=p._ctrl.bind(p);
        p._ctrl=async(cmd,...args)=>{calls[cmd]=(calls[cmd]||0)+1;return await ctrl(cmd,...args);};
        let t=performance.now(); await p.writeMem(0x24080000,data); const writeMs=performance.now()-t;
        t=performance.now(); const back=await p.readMem(0x24080000,data.length);const readMs=performance.now()-t;
        if(back.length!==data.length||back.some((v,i)=>v!==data[i]))throw new Error('SRAM mismatch');
        return {clockKhz:1000,writeMs,readMs,writeMBs:data.length/writeMs/1000,readMBs:data.length/readMs/1000,calls,maxWords:p.maxWords,packet:p.pkt,verified:true};
      }finally{try{await p.setClock(1000000);if(wasHalted===false)await p.run();}finally{await p.disconnect();}}
    `);
    results.push(r);console.log(JSON.stringify(r));
  }
}catch(e){results.push({error:e.stack});process.exitCode=1;console.error(e);}
finally{if(process.argv[2])await writeFile(process.argv[2],JSON.stringify(results,null,2),{flag:"wx"});c.close();}

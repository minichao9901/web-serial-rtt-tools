import { mkdir, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Cdp, sleep } from '../../../tools/selftest/cdp-lib.mjs';

const output = new URL('./', import.meta.url), lock = 'E:/web-etm-trace-coordination/hardware.lock';
const token = randomUUID(), c = new Cdp(undefined,180000);
const report = { started:new Date().toISOString(),result:'not-run' };
let locked=false,page;
try {
  await mkdir(lock);locked=true;
  await writeFile(lock+'/owner.json',JSON.stringify({owner:'codex-ram-fill',pid:process.pid,leaseToken:token,started:report.started}));
  page=await(await fetch(c.base+'/json/new?'+encodeURIComponent('about:blank'),{method:'PUT'})).json();
  c.ws=await c._open(page.webSocketDebuggerUrl,(_ws,message)=>c._dispatch(message));
  await c.send('Page.enable');await c.send('Runtime.enable');
  await c.send('Page.navigate',{url:'http://127.0.0.1:8899/index.html?modules=source&hid=mock&image-hardware='+Date.now()+'#dbg'});
  for(let i=0;i<100;i++){if(await c.eval('return !!window.__tools?.dbg?.imageFiles;').catch(()=>false))break;await sleep(50);}
  const devices=await c.eval(`const {WebUsbDapProbe:P}=await import('./app/rtt/dap-webusb.js');return(await P.authorized()).map(d=>({serial:d.serialNumber,vid:d.vendorId,pid:d.productId}));`);
  report.devices=devices;
  if(!devices.length)throw Error('No authorized probe; no hardware writes performed');
  const backup=await c.eval(`
    await window.__tools.probeBus.requestRelease({why:'RAM 填充命令实板验收'});
    const {WebUsbDapProbe:P}=await import('./app/rtt/dap-webusb.js');
    const p=await P.open((await P.authorized())[0],{clockKhz:1000});
    const h=window.__imageHW={p,wasHalted:null};
    const id={dp:p.idcode,device:await p._readWord(0xe0042000),flashKiB:(await p._readWord(0x1ffff7e0))&65535};
    if((id.device&4095)!==0x414||id.flashKiB!==512)throw Error('Expected F103ZE: '+JSON.stringify(id));
    h.wasHalted=!!((await p._readWord(0xe000edf0))&(1<<17));await p.halt();
    h.selectors=[...Array(19).keys(),20];h.regs=[];for(const n of h.selectors)h.regs.push(await p.regRead(n));
    h.ram=await p.readMemDiagnostic(0x20000000,65536);const confirm=await p.readMemDiagnostic(0x20000000,65536);
    if(confirm.length!==65536||h.ram.some((b,i)=>b!==confirm[i]))throw Error('RAM backup not stable');
    h.hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
    h.flash=await h.hash(await p.readMemDiagnostic(0x08000000,524288));
    return {id,wasHalted:h.wasHalted,selectors:h.selectors,regs:h.regs,flashSha256:h.flash,ramSha256:await h.hash(h.ram),ram:btoa(String.fromCharCode(...h.ram))};`);
  await writeFile(new URL('original-sram.bin',output),Buffer.from(backup.ram,'base64'),{flag:'wx'});
  delete backup.ram;report.backup=backup;
  await writeFile(new URL('backup.json',output),JSON.stringify(backup,null,2),{flag:'wx'});
  // The backup is durable before any fill command writes target memory.
  report.commands=await c.eval(`
    const {runCmd}=await import('./app/dbg/cmd.js');const {DebugSession}=await import('./app/dbg/session.js');
    const h=window.__imageHW;
    const s=new DebugSession();s.probe=h.p;s.connected=true;s.halted=true;
    const logs=[];h.p.onLog=text=>logs.push(text);await h.p.recoverDebugPort();
    if(logs.some(text=>/DAP 命令|恢复 SWD 调试连接/.test(text)))throw Error('Routine DAP logs still visible');
    const cases=[];let exported;
    for(const [command,address,length,value,inc] of [
      ['fill_ram 0x20008001 12289 0xA5',0x20008001,12289,165,false],
      ['fill_inc 0x20008001 12289 0xFD',0x20008001,12289,253,true],
      ['fill_ram 0x2000c003 513 0',0x2000c003,513,0,false],
      ['fill_ram 0x2000c403 513 255',0x2000c403,513,255,false],
      ['fill_inc 0x2000c803 513',0x2000c803,513,0,true]]){
      const result=await runCmd(command,s),bytes=await h.p.readMemDiagnostic(address-1,length+2);
      if(bytes.length!==length+2||bytes[0]!==h.ram[address-1-0x20000000]||bytes.at(-1)!==h.ram[address+length-0x20000000]||bytes.subarray(1,-1).some((b,i)=>b!==(inc?(value+i)&255:value)))throw Error('Pattern or boundary mismatch: '+command);
      cases.push({command,result:result.lines.map(l=>l.t),independentReadback:true,boundariesPreserved:true});
      if(inc&&length===12289)exported=btoa(String.fromCharCode(...bytes.subarray(1,-1)));
    }
    let stop=false,writes=0;const write=s.memWrite.bind(s);s.memWrite=async(a,b)=>{await write(a,b);writes++;stop=true;};
    let cancellation;try{await runCmd('fill_ram 0x20002001 8193 0x7B',s,{signal:()=>stop});throw Error('Cancellation did not stop');}catch(error){if(!error.cancelled)throw error;cancellation=error.message;}finally{s.memWrite=write;}
    const cancelled=await h.p.readMemDiagnostic(0x20002000,8195);
    if(writes!==1||cancelled.some((b,i)=>b!==(i>=1&&i<4097?123:h.ram[0x2000+i])))throw Error('Cancelled fill wrote beyond first chunk');
    return {cases,cancellation,writesBeforeCancel:writes,logs,routineLogsHidden:true,exported};`);
  await writeFile(new URL('increment-readback.bin',output),Buffer.from(report.commands.exported,'base64'),{flag:'wx'});delete report.commands.exported;
  report.result='passed';
} catch(error){report.error=error.stack;if(report.backup)report.result='failed';console.error(error.message);}
finally {
  if(page){
    try {
      report.restore=await c.eval(`
        const h=window.__imageHW;if(!h)return {notOpened:true};const p=h.p;const result={};
        try {
          if(h.ram){
            await p.setClock(1000000);await p.recoverDebugPort();await p.halt();await p.writeMem(0x20000000,h.ram);
            const bytes=await p.readMemDiagnostic(0x20000000,65536);
            if(bytes.length!==h.ram.length||bytes.some((b,i)=>b!==h.ram[i]))throw Error('Full SRAM restoration mismatch');result.fullSramRestored=true;
          }
          if(h.regs){const regs=[];for(const n of h.selectors)regs.push(await p.regRead(n));if(JSON.stringify(regs)!==JSON.stringify(h.regs))throw Error('Core registers changed');result.registersPreserved=true;}
          if(h.flash){result.flashSha256=await h.hash(await p.readMemDiagnostic(0x08000000,524288));if(result.flashSha256!==h.flash)throw Error('Flash changed');result.flashUnchanged=true;}
          if(h.wasHalted===false){await p.run();if((await p._readWord(0xe000edf0))&(1<<17))throw Error('CPU did not resume');result.cpuResumed=true;}
          else result.cpuKeptHalted=h.wasHalted===true;
          if(h.directory)await(await navigator.storage.getDirectory()).removeEntry(h.directory,{recursive:true});
          return result;
        } finally {await p.disconnect();}`);
    } catch(error){report.restoreError=error.stack;report.result='failed';}
    c.close();await fetch(c.base+'/json/close/'+page.id).catch(()=>{});
  }
  if(locked){
    try {const owner=JSON.parse(await readFile(lock+'/owner.json','utf8'));if(owner.leaseToken!==token)throw Error('Hardware lease token changed');await unlink(lock+'/owner.json');await rmdir(lock);report.leaseReleased=true;}
    catch(error){report.leaseReleaseError=error.message;}
  }
  report.finished=new Date().toISOString();await writeFile(new URL('hardware.json',output),JSON.stringify(report,null,2),{flag:'wx'});
  console.log(JSON.stringify(report,null,2));if(report.result==='failed')process.exitCode=1;
}

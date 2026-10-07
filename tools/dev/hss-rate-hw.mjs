// One command: build a rated-clock fixture, preserve Flash, program and measure the real web path.
import {spawn, spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Cdp, sleep} from '../selftest/cdp-lib.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
process.chdir(root);
const options=Object.fromEntries(process.argv.slice(2).map(x=>{
  if(!x.startsWith('--'))throw Error('Use --name=value options');
  const i=x.indexOf('=');return i<0?[x.slice(2),true]:[x.slice(2,i),x.slice(i+1)];
}));
const known=new Set(['help','board','cpu','seconds','clock','port','cdp','periods','out','no-flash','overload']);
for(const key of Object.keys(options))if(!known.has(key))throw Error('Unknown option: --'+key);
for(const key of ['help','no-flash','overload'])if(key in options && options[key]!==true)throw Error('Use --'+key+' without a value');
if(options.help){
  console.log('make test-hss-rate BOARD=ze HSS_SECONDS=8 HSS_CLOCK=60');
  console.log('Builds/flashes the F103 test fixture (default 72 MHz), backs up original Flash, opens web and measures 2/2.25/2.5/3 us.');
  console.log('Options: --board=ze|cb --seconds=8 --clock=60 --periods=2,2.25,2.5,3 --cpu=72|96 --port=8899 --cdp=9333 --out=DIR --no-flash --overload');
  process.exit(0);
}
const board=options.board||'ze',cpu=Number(options.cpu||72),seconds=Number(options.seconds||8),clock=Number(options.clock||60);
const port=Number(options.port||8899),cdpPort=Number(options.cdp||9333);
const periods=String(options.periods||'2,2.25,2.5,3').split(',').map(Number);
if(!['ze','cb'].includes(board)||![72,96].includes(cpu)||seconds<1||seconds>30||!Number.isFinite(seconds)||
  ![1,5,10,20,30,40,45,50,60].includes(clock)||!periods.length||periods.some(p=>!Number.isFinite(p)||p<=0)||
  !Number.isInteger(port)||port<1024||port>65535||!Number.isInteger(cdpPort)||cdpPort<1024||cdpPort>65535)
  throw Error('Invalid hardware benchmark options');
const runDir=resolve(options.out||`tmp/hss-${board}-${new Date().toISOString().replace(/[:.]/g,'-')}`);
if(['original-flash.bin','metadata.json','results.json'].some(name=>existsSync(join(runDir,name))))
  throw Error('Run directory already contains evidence; choose a fresh --out directory');
mkdirSync(runDir,{recursive:true});
const app=`http://127.0.0.1:${port}/index.html`,cdp=`http://127.0.0.1:${cdpPort}`;
function run(exe,args){
  const r=spawnSync(exe,args,{cwd:root,encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:8*1024*1024});
  const output=(r.stdout||'')+(r.stderr||'');
  if(r.error||r.status!==0)throw Error(`${exe} failed (${r.status}): ${r.error?.message||output}`);
  return output;
}
async function alive(url){try{return (await fetch(url,{signal:AbortSignal.timeout(2000)})).ok;}catch{return false;}}
async function waitFor(url){for(let i=0;i<40;i++){if(await alive(url))return;await sleep(250);}throw Error('Service unavailable: '+url);}
if(!await alive(app)){
  const server=spawn(process.execPath,['tools/dev/serve-nocache.mjs',String(port)],{cwd:root,detached:true,stdio:'ignore',windowsHide:true});
  server.unref();await waitFor(app);
}
if(!await alive(cdp+'/json/version')){
  run('pwsh',['-NoProfile','-File','tools/selftest/launch-browser.ps1','-Port',String(cdpPort),'-Url',app]);
  await waitFor(cdp+'/json/version');
}
const c=new Cdp(cdp,30000);await c.connect();
try{
  // Release existing owners through the application lifecycle, before OpenOCD opens USB.
  await c.eval(`const t=window.__tools;if(t?.probeManager)await t.probeManager.releaseOthers(null,'HSS 真机测速');return true;`);
}finally{c.close();}
const buildName=(board==='ze'?'build':'build-cb')+(cpu===96?'':`-${cpu}mhz`);
const elfPath=`tools/target-firmware/stm32f103_scope/${buildName}/fw.elf`;
const metadata={startedAt:new Date().toISOString(),board,cpuMHz:cpu,requestedClockMHz:clock,periods,seconds,elfPath};
if(!options['no-flash']){
  console.log(`F103${board.toUpperCase()}: backing up original Flash before flashing the ${cpu} MHz scope fixture.`);
  console.log(run('pwsh',['-NoProfile','-File','tools/target-firmware/stm32f103_scope/build.ps1','-Board',board,'-CpuMhz',String(cpu)]));
  const found=process.env.OPENOCD ? [process.env.OPENOCD] : JSON.parse(run('pwsh',['-NoProfile','-Command',
    "@((Get-ChildItem 'E:/Share/env-windows/xpack-openocd-*/bin/openocd.exe' -ErrorAction SilentlyContinue | Sort-Object FullName | ForEach-Object FullName); (Get-Command openocd -ErrorAction SilentlyContinue).Source) | ConvertTo-Json -Compress -AsArray"]));
  const exe=found.find(p=>p&&existsSync(p));if(!exe)throw Error('Set OPENOCD to an OpenOCD 0.12+ executable');
  const scripts=process.env.OPENOCD_SCRIPTS||[join(dirname(exe),'../openocd/scripts'),join(dirname(exe),'../share/openocd/scripts')].find(p=>existsSync(join(p,'interface/cmsis-dap.cfg')));
  if(!scripts)throw Error('Set OPENOCD_SCRIPTS to the matching scripts directory');
  const common=['-s',scripts,'-f','interface/cmsis-dap.cfg','-c','cmsis-dap backend usb_bulk','-f','target/stm32f1x.cfg'];
  const inspect=run(exe,[...common,'-c','adapter speed 1000; init; halt; flash probe 0; resume; shutdown']);
  writeFileSync(join(runDir,'target-inspect.log'),inspect);
  const id=/device id = (0x[0-9a-f]+)/i.exec(inspect)?.[1],kb=Number(/flash size = (\d+) KiB/i.exec(inspect)?.[1]);
  const expected=board==='ze'?{id:0x414,kb:512}:{id:0x410,kb:128};
  if(!id||(Number(id)&0xfff)!==expected.id||kb!==expected.kb)throw Error(`Wrong target: ${id}, ${kb} KiB; expected F103${board.toUpperCase()}`);
  const backup=join(runDir,'original-flash.bin');
  if(existsSync(backup))throw Error('Backup already exists; choose a fresh --out directory');
  const tclPath=p=>{const s=resolve(p).replaceAll('\\','/');if(/[{}\r\n]/.test(s))throw Error('Unsupported Tcl path');return `{${s}}`;};
  const saved=run(exe,[...common,'-c',`adapter speed 1000; init; reset halt; dump_image ${tclPath(backup)} 0x08000000 ${kb*1024}; resume; shutdown`]);
  writeFileSync(join(runDir,'backup.log'),saved);
  if(!existsSync(backup)||readFileSync(backup).length!==kb*1024)throw Error('Flash backup incomplete; refusing to program');
  metadata.deviceId=id;metadata.flashKiB=kb;metadata.backupPath=backup;
  metadata.backupSha256=createHash('sha256').update(readFileSync(backup)).digest('hex');
  writeFileSync(join(runDir,'metadata.json'),JSON.stringify(metadata,null,2)+'\n');
  const programmed=run(exe,[...common,'-c',`adapter speed 1000; init; program ${tclPath(elfPath)} verify reset exit`]);
  writeFileSync(join(runDir,'flash.log'),programmed);
  if(!programmed.includes('Verified OK'))throw Error('Flash verification missing');
}
if(!existsSync(elfPath))throw Error('Matching fixture ELF is missing');
metadata.elfSha256=createHash('sha256').update(readFileSync(elfPath)).digest('hex');
writeFileSync(join(runDir,'metadata.json'),JSON.stringify(metadata,null,2)+'\n');
process.env.SCOPE_ELF=elfPath;process.env.SCOPE_CLOCK_MHZ=String(clock);process.env.CDP=cdp;process.env.APP=app;
const resultsPath=join(runDir,'results.json');
const cases=periods.map(period=>({period,draw:true,adaptive:true}));
if(options.overload){
  const vars=['g_pack.f_sin','g_pack.f_tri','g_pack.i_tick','g_pack.u_ramp','g_pack.i_sq1k','g_pack.u_cnt','g_pack.i_saw','g_pack.u_hi'];
  cases.push({period:1,draw:true,adaptive:true},{period:2,draw:true,adaptive:true,vars},
    {period:20,draw:true,adaptive:true,vars},{period:3,draw:true,adaptive:true,vars:['g_pack.u_hi']});
}
process.argv=[process.execPath,'hss-web-bench.mjs',resultsPath,JSON.stringify(cases),String(seconds)];
await import('./hss-web-bench.mjs');
const results=JSON.parse(readFileSync(resultsPath,'utf8'));
console.table(results.rows.map(r=>({periodUs:r.requestedUs,effectiveUs:r.effectiveUs,kHz:+(r.stable.probeHz/1000).toFixed(3),
  skipPercent:+r.stable.dropPercent.toFixed(5),usbDrops:r.stable.usb,readErrors:r.stable.errors,bad:r.bad})));
console.log(`Read calibration ${results.calibration.readUs.toFixed(3)} us; starting recommendation ${results.calibration.recommendedUs} us (verify capture counters).`);
console.log('Results and original Flash backup: '+runDir);

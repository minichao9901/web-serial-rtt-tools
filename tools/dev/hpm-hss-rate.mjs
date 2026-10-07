// Measurement only: flash the matching hpm6800evk_scope fixture first.
import {spawnSync} from 'node:child_process';
import {mkdirSync,existsSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const out=resolve(process.argv[2]||'tmp/hpm-hss-'+new Date().toISOString().replace(/[:.]/g,'-'));
const seconds=Number(process.argv[3]||8);
if(!Number.isFinite(seconds)||seconds<1||seconds>30)throw Error('Seconds must be 1..30');
if(['rate.json','smooth.json'].some(n=>existsSync(join(out,n))))throw Error('Choose a fresh output directory');
mkdirSync(out,{recursive:true});
const vars=['g_v.tick','g_v.u_hi','g_v.f_sin','g_v.f_tri','g_v.i_sq1k','g_v.i_sq5k','g_v.u_ramp','g_v.lfsr'];
const env={...process.env,SCOPE_TARGET:'riscv',
  SCOPE_ELF:process.env.SCOPE_ELF||'tools/target-firmware/hpm6800evk_scope/build/flash_xip/output/demo.elf'};
function measure(name,contract,cases){
  const r=spawnSync(process.execPath,['tools/dev/hss-web-bench.mjs',join(out,name+'.json'),JSON.stringify(cases),String(seconds)],
    {cwd:root,env:{...env,SCOPE_CONTRACT:contract},stdio:'inherit',windowsHide:true,timeout:600000});
  if(r.error||r.status!==0)throw Error('Capture failed: '+name+' '+(r.error||r.status));
}
measure('rate','g_v.u_hi',[
  ...[2,3.25,4,5,6,10].map(period=>({period,draw:true,adaptive:true})),
  {period:3.25,draw:true,adaptive:true,batch:false},
  {period:40,draw:true,adaptive:false,vars,stallMs:25},
  {period:40,draw:true,adaptive:true,vars,stallMs:25},
  ...[40,47,60].map(period=>({period,draw:true,adaptive:true,vars}))
]);
measure('smooth','g_v_hi.tick',[
  {period:2,draw:true,adaptive:true},
  ...[20,25].map(period=>({period,draw:true,adaptive:true,vars:['g_v_hi.tick','g_v_hi.f_sin']}))
]);
console.log('HPM real WebUSB rate/integrity evidence: '+out);

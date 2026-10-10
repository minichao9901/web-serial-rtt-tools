/** Formal oracle collector. Requires a running GDB server; never flashes firmware. */
import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync,mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Elf} from '../../app/elf/elf.js';
import {FRAME_CASES,sha256,readJson,validateBuild,validateOracle} from './dbg-frame-contract.mjs';
const args=process.argv.slice(2),arg=(key,def)=>args.find(a=>a.startsWith('--'+key+'='))?.slice(key.length+3)??def;
const pyLiteral=value=>value===null?'None':typeof value==='boolean'?(value?'True':'False'):
 typeof value==='number'?String(value):typeof value==='string'?'u'+JSON.stringify(value):
 Array.isArray(value)?'['+value.map(pyLiteral).join(',')+']':
 value&&typeof value==='object'?'{'+Object.entries(value).map(([k,v])=>'u'+JSON.stringify(k)+':'+pyLiteral(v)).join(',')+'}':
 (()=>{throw new Error('不能注入 GDB 配置值：'+typeof value)})();
if(args.includes('--help')){console.log('node tools/selftest/dbg-frame-gdb-oracle.mjs --elf=.../fw.elf --board=f103cb|h743|6800evk|5301evklite --remote=127.0.0.1:3333 --out=tmp/frame-oracle.json [--gdb=<matching-gdb>]');process.exit(0);}
const elfPath=arg('elf');if(!elfPath)throw new Error('--elf 必须明确指定最终构建 ELF');
const board=arg('board','f103cb'),remote=arg('remote','127.0.0.1:3333');
if(!['f103cb','f103ze','h743','6800evk','5301evklite'].includes(board)||!/^[-\w.]+:\d+$/.test(remote))throw new Error('board 或 remote 格式无效');
const bytes=new Uint8Array(readFileSync(elfPath)),elf=new Elf(bytes),build=readJson(arg('build',join(dirname(elfPath),'build-info.json')));
validateBuild(build,bytes,board);
const symbols=elf.symbols(true),cases=FRAME_CASES.map(c=>{
 const symbol=symbols.find(s=>s.name===c.checkpoint);if(!symbol)throw new Error('ELF 缺少测试检查点 '+c.checkpoint);
 return {...c,address:(symbol.addr&0xfffffffe)>>>0};
});
const isRiscv=board==='6800evk'||board==='5301evklite';
const [codeStart,codeEnd]=isRiscv?[0x80000000,0x81000000]:[0x08000000,0x09000000];
const code=elf.sections().filter(s=>(s.flags&2)&&!(s.flags&1)&&s.type===1&&s.addr>=codeStart&&s.addr<codeEnd).map(s=>({name:s.name,addr:s.addr,hex:Buffer.from(elf.data(s.name)).toString('hex')}));
if(!code.some(s=>s.name==='.text'))throw new Error('ELF 缺少可验证目标代码');
const out=resolve(arg('out','tmp/frame-oracle-'+board+'.json'));
if(args.includes('--validate-only')){validateOracle(readJson(out),build,bytes,board);console.log('GDB oracle preflight passed: '+out);process.exit(0);}
mkdirSync(dirname(out),{recursive:true});
// Failed collection must not leave an older answer available for release acceptance.
rmSync(out,{force:true});
const temp=mkdtempSync(join(tmpdir(),'akalink-frame-oracle-'));
try{
 const script=join(temp,'run.gdb'),py=fileURLToPath(new URL('./dbg-frame-gdb.py',import.meta.url));
 const config={board,remote,build,elfSha256:sha256(bytes),cases,code,out};
 // Keep the collector independent of a separately installed Python stdlib: some
 // embedded cross-GDB builds expose only their _gdb extension and builtins.
 writeFileSync(script,`python\nCONFIG = ${pyLiteral(config)}\nexec(compile(open(${JSON.stringify(py)}).read(), ${JSON.stringify(py)}, "exec"))\nend\n`);
 const defaultGdb=isRiscv?'riscv32-unknown-elf-gdb':'arm-none-eabi-gdb';
 const child=spawn(arg('gdb',defaultGdb),['-q','-nx','-batch',resolve(elfPath),'-x',script],{stdio:'inherit',env:{...process.env}});
 const timeout=setTimeout(()=>child.kill(),180000);
 const status=await new Promise((res,rej)=>{child.once('error',rej);child.once('exit',res);}).finally(()=>clearTimeout(timeout));
 if(status!==0)throw new Error('GDB 采集失败；需要支持 Python 的 GDB，且目标/连接不能被其他工具占用');
 validateOracle(readJson(out),build,bytes,board);console.log('GDB frame oracle verified: '+out);
}catch(error){rmSync(out,{force:true});throw error;}finally{rmSync(temp,{recursive:true,force:true});}

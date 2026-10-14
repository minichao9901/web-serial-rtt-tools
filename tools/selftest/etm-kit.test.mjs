import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {etmKitFiles,etmKitConfig} from '../../app/gen/etm-kit.js';
import {ETM_SCRIPTS} from '../../app/gen/etm-kit-src.js';
import {zipStore} from '../../app/gen/zip.js';
for(const [name,embedded] of Object.entries(ETM_SCRIPTS)){
  const source=readFileSync(new URL('../dev/'+name,import.meta.url),'utf8').replace(/\r\n/g,'\n');
  assert.equal(embedded.src,source,'downloaded script drift: '+name);
  assert.equal(embedded.sha256,createHash('sha256').update(source).digest('hex'));
}
for(const port of ['evil & calc',-1,1023,65536,8878.5])assert.throws(()=>etmKitConfig({port}));
assert.equal(etmKitConfig({port:8878}).port,8878);
const config={port:8880};
const files=etmKitFiles(config);
assert.equal(files.length,5);
const ps=files.find(f=>f.name.endsWith('.ps1'));
assert.equal(new TextDecoder('utf8',{ignoreBOM:true}).decode(ps.data).charCodeAt(0),0xfeff,'Windows PowerShell requires UTF8 BOM');
for(const f of files.filter(f=>f.name.endsWith('.bat')))assert(!/[^\r]\n/.test(f.text));
assert.deepEqual(JSON.parse(files.find(f=>f.name.endsWith('.json')).text),config);
if(process.env.VALIDATION_DIR){
  const root=process.env.VALIDATION_DIR;
  for(const file of files){
    const path=join(root,'解压 包测试',file.name);mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,file.data);
  }
  writeFileSync(join(root,'etm-bridge-kit.zip'),zipStore(files.map(f=>({name:f.name,data:f.data}))));
}
console.log('PASS: portable launchers, no project paths, script identity, encoding and ZIP (5 files)');

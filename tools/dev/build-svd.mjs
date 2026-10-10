/** Store compact fetchable copies without changing the original vendor XML. */
import {readFileSync,writeFileSync} from 'node:fs';
import {gzipSync} from 'node:zlib';
import {BUNDLED_SVDS} from '../../app/dbg/svd/bundled.js';
for(const asset of BUNDLED_SVDS){
  const file=new URL('../../app/dbg/svd/'+asset.file,import.meta.url),bytes=Buffer.from(readFileSync(file,'utf8').replace(/\r\n/g,'\n'));
  writeFileSync(new URL(file.href+'.gz'),gzipSync(bytes,{level:9}));
}
console.log(`SVD compressed copies built: ${BUNDLED_SVDS.length}`);

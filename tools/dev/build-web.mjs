/** Build a checked-in static entry; no Node/npm is needed to serve the result. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,relative,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),out=resolve(root,'app/site');
const manifestPath=resolve(out,'manifest.json'),entryPath=resolve(out,'main.js');
// Git may check text out with CRLF on Windows and LF on Linux. Hash canonical text.
const sha=bytes=>createHash('sha256').update(Buffer.from(bytes).toString('utf8').replace(/\r\n/g,'\n')).digest('hex');
if(process.argv.includes('--check')){
 const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
 for(const [path,hash]of Object.entries(manifest.inputs))if(sha(await readFile(resolve(root,path)))!==hash)throw Error(`线上脚本未更新：${path}，请运行 npm run build:web`);
 if(sha(await readFile(entryPath))!==manifest.outputSha256)throw Error('线上脚本与构建清单不符，请运行 npm run build:web');
 if(!(await readFile(resolve(root,'index.html'),'utf8')).includes(`app/site/main.js?v=${manifest.outputSha256.slice(0,16)}`))throw Error('页面入口与发布脚本版本不符，请运行 npm run build:web');
 console.log(`web bundle current: ${Object.keys(manifest.inputs).length} source modules`);
}else{
 const {build,transform}=await import('esbuild');
 const result=await build({absWorkingDir:root,entryPoints:['app/main.js'],outfile:entryPath,bundle:true,
  format:'esm',platform:'browser',target:'es2022',minify:true,keepNames:true,charset:'utf8',legalComments:'inline',metafile:true,write:false,
  plugins:[{name:'original-module-urls',setup(b){
   // Leave optional features in their source locations, loaded only when used.
   b.onResolve({filter:/^\./},args=>{
    if(args.kind!=='dynamic-import')return;
    const path=relative(out,resolve(args.resolveDir,args.path)).replaceAll('\\','/');
    return {path:path.startsWith('.')?path:'./'+path,external:true};
   });
   // Bundling must not move Worker, SVD or SWO sample URLs to app/site/.
   b.onLoad({filter:/\.m?js$/},async args=>{
    const source=await readFile(args.path,'utf8');if(!source.includes('import.meta.url'))return;
    const transformed=await transform(source,{loader:'js',format:'esm',target:'es2022',legalComments:'inline',define:{'import.meta.url':'__srtOriginalModuleUrl'}});
    const path=relative(out,args.path).replaceAll('\\','/');
    return {contents:`const __srtOriginalModuleUrl=new URL(${JSON.stringify(path)},import.meta.url).href;\n`+transformed.code,loader:'js',resolveDir:dirname(args.path)};
   });
  }}]});
 const inputs={};for(const path of Object.keys(result.metafile.inputs).sort())inputs[path.replaceAll('\\','/')]=sha(await readFile(resolve(root,path)));
 const output=result.outputFiles.find(f=>f.path===entryPath);if(!output)throw Error('Build produced no entry');
 await mkdir(out,{recursive:true});await writeFile(entryPath,output.contents);
 await writeFile(manifestPath,JSON.stringify({schema:1,esbuild:'0.25.12',inputs,outputSha256:sha(output.contents),outputBytes:output.contents.length},null,2)+'\n');
 const indexPath=resolve(root,'index.html'),html=await readFile(indexPath,'utf8');
 if(!/window\.__webBundleUrl = '[^']+';/.test(html))throw Error('页面缺少发布脚本入口');
 await writeFile(indexPath,html.replace(/window\.__webBundleUrl = '[^']+';/,`window.__webBundleUrl = 'app/site/main.js?v=${sha(output.contents).slice(0,16)}';`));
 console.log(`web bundle built: ${Object.keys(inputs).length} modules -> ${output.contents.length} bytes`);
}

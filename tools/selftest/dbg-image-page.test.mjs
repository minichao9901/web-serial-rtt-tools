/** Real debugger commands + browser File System Access (OPFS), no physical probe. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const base = process.env.CDP || 'http://127.0.0.1:9333';
const app = process.env.APP || 'http://127.0.0.1:8899/index.html';
const out = resolve(process.env.IMAGE_OUT || `tmp/dbg-image-page-${Date.now()}`);
await mkdir(out, { recursive: true });
const results = [];
for (const mode of ['source', 'bundle']){
  const page = await (await fetch(base + '/json/new?' + encodeURIComponent('about:blank'), { method: 'PUT' })).json();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  ws.onmessage = event => {
    const message = JSON.parse(event.data), request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer); pending.delete(message.id);
    message.error ? request.reject(Error(message.error.message)) : request.resolve(message.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error(method + ' timeout')); }, 30000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async source => {
    const result = await send('Runtime.evaluate', { expression: `(async()=>{${source}})()`, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const directory = `dbg-image-test-${mode}-${Date.now()}`;
  try {
    await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
    await send('Network.setCacheDisabled', { cacheDisabled: true });
    await send('Page.navigate', { url: app + `?demo=serial&hid=mock&modules=${mode}&image-test=${Date.now()}#dbg` });
    assert.equal(await evaluate(`for(let i=0;i<150&&!document.getElementById('build-stamp');i++)await new Promise(r=>setTimeout(r,20));return !!window.__tools?.dbg?.imageFiles;`), true);
    const result = await evaluate(`
      const view=window.__tools.dbg, $=id=>document.getElementById(id);
      $('d-backend').value='mock';await view._syncBackend();await view.connect();
      if(!view.session.connected)throw Error('mock debugger not connected');
      $('d-side-session-tab').click();
      const missing=await view.runLine('dump_image before.bin 0x20001000 4');
      const storage=await navigator.storage.getDirectory(),root=await storage.getDirectoryHandle('${directory}',{create:true});
      window.__imageTestRoot=root;window.__imagePicker=globalThis.showDirectoryPicker;
      let requestedMode='';globalThis.showDirectoryPicker=async options=>{requestedMode=options.mode;return root;};
      $('d-image-pick').click();for(let i=0;i<100&&!view.imageFiles.root;i++)await new Promise(r=>setTimeout(r,20));
      const folder=await root.getDirectoryHandle('sub dir',{create:true});
      const bytes=Uint8Array.from({length:12289},(_,i)=>(i*37+(i>>>7))&255);
      const input=await folder.getFileHandle('input data.bin',{create:true}),inputWriter=await input.createWritable();await inputWriter.write(bytes);await inputWriter.close();
      const pc=view.session.pc,halted=view.session.halted,symbols=view.session.sym;
      const originalRun=view.runLine.bind(view);view.runLine=line=>window.__imageCommand=originalRun(line);
      $('d-cmd').value='load_image {sub dir/input data.bin} 0x20001000 bin';
      $('d-cmd').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
      const loaded=await window.__imageCommand;view.runLine=originalRun;
      const actual=await view.session.memRead(0x20001000,bytes.length);
      const dumped=await view.runLine('dump_image "sub dir/output data.bin" 0x20001000 12289');
      const output=await folder.getFileHandle('output data.bin'),back=new Uint8Array(await(await output.getFile()).arrayBuffer());
      const protectedFile=await root.getFileHandle('preserved.bin',{create:true}),originalWriter=await protectedFile.createWritable();await originalWriter.write(Uint8Array.of(99,88));await originalWriter.close();
      const read=view.session.memRead.bind(view.session);view.session.memRead=async(a,n)=>{const b=await read(a,n);view.cancelFlag=true;return b;};
      const cancelled=await view.runLine('dump_image preserved.bin 0x20001000 12289');view.session.memRead=read;
      const preserved=new Uint8Array(await(await protectedFile.getFile()).arrayBuffer());
      const traversal=await view.runLine('dump_image ../outside.bin 0x20001000 4');
      const empty=await view.runLine('dump_image empty.bin 0x20001000 0');
      const emptySize=(await(await root.getFileHandle('empty.bin')).getFile()).size;
      const filled=await view.runLine('fill_ram 0x20001001 9001 0xA5');
      const constant=await view.session.memRead(0x20001001,9001);
      const incremented=await view.runLine('fill_inc 0x20001001 9001 0xFD');
      const incremental=await view.session.memRead(0x20001001,9001);
      const fillOk=!filled.error&&!incremented.error&&constant.every(b=>b===165)&&incremental.every((b,i)=>b===((253+i)&255));
      $('d-cmd').value='fill_i';$('d-cmd').dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true}));const fillCompletion=$('d-cmd').value;
      $('d-cmd').value='load_im';$('d-cmd').dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true}));const completion=$('d-cmd').value;$('d-cmd').value='';
      const help=await view.runLine('h');
      const statePreserved=view.session.pc===pc&&view.session.halted===halted&&view.session.sym===symbols;
      return {mode:'${mode}',requestedMode,missing:missing.error,loaded:loaded.error||loaded.lines.at(-1).t,
        dumped:dumped.error||dumped.lines.at(-1).t,roundtrip:actual.length===bytes.length&&actual.every((b,i)=>b===bytes[i])&&back.length===bytes.length&&back.every((b,i)=>b===bytes[i]),
        statePreserved,cancelled:!!cancelled.cancelled,preserved:[...preserved],traversal:traversal.error,
        empty:!empty.error&&emptySize===0,completion,fillOk,fillCompletion,help:help.lines.some(l=>l.t.includes('load_image filename'))&&help.lines.some(l=>l.t.includes('dump_image filename'))&&help.lines.some(l=>l.t.includes('fill_ram'))&&help.lines.some(l=>l.t.includes('fill_inc')),
        label:$('d-image-dir').textContent,errors:window.__tools.errors};`);
    assert.equal(result.requestedMode, 'readwrite');
    assert.match(result.missing, /镜像目录/); assert.match(result.loaded, /downloaded 12289 bytes/);
    assert.match(result.dumped, /dumped 12289 bytes/); assert.equal(result.roundtrip, true);
    assert.equal(result.statePreserved, true); assert.equal(result.cancelled, true);
    assert.deepEqual(result.preserved, [99,88]); assert.match(result.traversal, /授权目录/);
    assert.equal(result.empty, true); assert.equal(result.completion, 'load_image '); assert.equal(result.help, true);
    assert.equal(result.fillOk,true);assert.equal(result.fillCompletion,'fill_inc ');
    assert.equal(result.label, directory); assert.deepEqual(result.errors, []);
    results.push(result);
    await evaluate(`document.getElementById('d-side-session-tab').click();document.querySelector('#tab-dbg .side').scrollTop=0;`);
    for (const width of [1280,1600]){
      await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
      const layout = await evaluate(`return {root:document.documentElement.scrollWidth-innerWidth,side:document.querySelector('#tab-dbg .side').scrollWidth-document.querySelector('#tab-dbg .side').clientWidth};`);
      assert.ok(layout.root <= 1 && layout.side <= 1);
      const screenshot = await send('Page.captureScreenshot', { format: 'png' });
      await writeFile(resolve(out, `${mode}-${width}.png`), Buffer.from(screenshot.data,'base64'));
    }
    console.log(`dbg-image-page ${mode}: directory button, literal file paths, keyboard load, 12KiB roundtrip, state preservation, cancelled export rollback, zero dump, traversal rejection, help/completion and 1280/1600 layout PASS`);
  } finally {
    try { await evaluate(`if(window.__tools?.dbg)await window.__tools.dbg.disconnect();if(window.__imagePicker)globalThis.showDirectoryPicker=window.__imagePicker;await(await navigator.storage.getDirectory()).removeEntry('${directory}',{recursive:true});`); } catch {}
    ws.close(); await fetch(base + '/json/close/' + page.id);
  }
}
await writeFile(resolve(out,'result.json'),JSON.stringify({result:'passed',time:new Date().toISOString(),cases:results},null,2));
console.log('Evidence: ' + out);

import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {OperationBudget} from '../../app/core/operation-budget.js';
import {AnsiDisplay} from '../../app/core/display-stream.js';
import {MockSpiTransport} from '../../app/spi/transport.js';
import {usbResourceConflict,isUsbResourceConflict} from '../../app/core/usb-device.js';
import {initDockNavigation} from '../../app/ui/dock-navigation.js';
import {WebUsbDapProbe} from '../../app/rtt/dap-webusb.js';
const tick=()=>new Promise(r=>setImmediate(r));
{
 const probe=new WebUsbDapProbe(),logs=[];probe.onLog=text=>logs.push(text);
 await probe._budgeted('恢复 SWD 调试连接',async()=>{probe._operationBudget.check('DAP 命令 0x2');probe._operationBudget.check('DAP 命令 0x6');});
 assert.deepEqual(logs,[],'routine DAP budget stages must not fill the user log');
 await assert.rejects(probe._budgeted('恢复 SWD 调试连接',async()=>{probe._operationBudget.deadline=performance.now()-1;probe._operationBudget.check('DAP 命令 0x6');}),e=>e.code==='OPERATION_TIMEOUT'&&e.message.includes('DAP 命令 0x6'));
 assert.equal(probe._operationBudget,null);probe._note('USB 写超时');assert.deepEqual(logs,['USB 写超时'],'real recovery diagnostics remain visible');
}
{
 const budget=new OperationBudget('test operation',100),held={};let calls=0;budget.deadline=performance.now()-1;
 await assert.rejects(budget.step('new request',async()=>{calls++;}),e=>e.code==='OPERATION_TIMEOUT'&&e.message.includes('new request'));assert.equal(calls,0);
 const active=new OperationBudget('test in flight',100);let resolve;const p=active.step('wire',()=>new Promise(r=>resolve=r));active.deadline=performance.now()-1;let finished=false;p.catch(()=>{finished=true;});await tick();assert.equal(finished,false,'deadline must not abandon a pending native request');resolve();await assert.rejects(p,/总等待预算/);
}
{
 let error,shouldFail=true,delivered=0;const display=new AnsiDisplay({write(bytes,done){if(shouldFail)throw Error('render failed');delivered++;done();}},{onError:e=>error=e});
 try{display.push(Uint8Array.of(1));assert.doesNotThrow(()=>display.flush());assert.equal(error.message,'render failed');display.push(Uint8Array.of(2));display.flush();assert.equal(delivered,0);display.clear();shouldFail=false;display.push(Uint8Array.of(3));display.flush();assert.equal(delivered,1);}finally{clearInterval(display.timer);}
}
{
 let taken=false,delivered=0;const t=new MockSpiTransport({probe:{takeRsp:()=>taken?null:(taken=true,Uint8Array.of(1))},latencyMs:30});t.running=true;t.onRsp=()=>delivered++;const pending=t._drain();await tick();await t.stop();await pending;assert.equal(delivered,0,'old response cannot leak after stop');
}
assert.equal(isUsbResourceConflict(usbResourceConflict('wording can change')),true);assert.equal(isUsbResourceConflict(Error('USB 整设备复位需要先断开')),false);
{
 const {document,window}=parseHTML('<html><body><section class="panel"><div id="p-tabs" class="docktabs"><button data-dock="first" class="on">first</button><button data-dock="second">second</button></div><div class="dockpage on" data-dock="first"></div><div class="dockpage" data-dock="second"></div></section></body></html>');
 globalThis.document=document;globalThis.MutationObserver=window.MutationObserver;
 const buttons=[...document.querySelectorAll('button')];for(const button of buttons)button.addEventListener('click',()=>{for(const b of buttons)b.classList.toggle('on',b===button);});
 initDockNavigation();const event=new window.Event('keydown',{bubbles:true,cancelable:true});Object.defineProperty(event,'key',{value:'ArrowRight'});buttons[0].dispatchEvent(event);await tick();assert.equal(buttons[1].getAttribute('aria-selected'),'true');assert.equal(buttons[1].getAttribute('role'),'tab');assert.equal(buttons[0].tabIndex,-1);assert.ok(buttons[1].getAttribute('aria-controls'));
}
console.log('web review maintenance: deadline stops new work without abandoning in-flight work; rendering recovery; mock cancellation; typed ownership errors; dock keyboard/ARIA PASS');

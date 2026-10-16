import assert from 'node:assert/strict';
import { Cdp, sleep } from '../../../tools/selftest/cdp-lib.mjs';
import { writeFileSync } from 'node:fs';

// 96 MHz 靶子上的烧录页 SRAM 读写测速（用户 2026-10-16 口径）：
// 先烧 `stm32f103_rtt_speed/build-ze`（HSE 8 MHz ×12 = 96 MHz），再跑同一套 20 KiB × 3 轮
// 写入校验 + 3 轮读回校验的页面基准；每组之后断言 CPU 仍暂停、17 个体系寄存器与 RCC 未变。
// 对照组：48 MHz 靶子（用户原固件）的 24 组见 production-ui.json。
const KHZ = [1000, 4000, 10000, 20000, 36000, 45000, 60000, 0];
const REPEATS = 3;
const out = new URL('./', import.meta.url);
const c = new Cdp(undefined, 120000);
const report = { target: 'stm32f103_rtt_speed build-ze (96 MHz)', cases: [], errors: [] };
const probeOpen = `const {WebUsbDapProbe:P}=await import('./app/rtt/dap-webusb.js');const p=await P.open((await P.authorized())[0],{clockKhz:1000});`;
/** F103 RCC_CFGR 解码：SW/SWS/HPRE/PPRE/PLLSRC/PLLXTPRE/PLLMUL */
function decodeCfgr(v) {
  const hse = 8;                                     // 板上晶振实测 8.005 MHz，按 8 算
  const pllMul = ['×2','×3','×4','×5','×6','×7','×8','×9','×10','×11','×12','×13','×14','×15','×16','×16'][(v >>> 18) & 0xf];
  const sw = ['HSI','HSE','PLL','—'][v & 3], sws = ['HSI','HSE','PLL','—'][(v >>> 2) & 3];
  const src = (v >>> 16) & 1 ? 'HSE' : 'HSI/2';
  const xtpre = (v >>> 17) & 1 ? 'HSE/2' : 'HSE';
  const mul = Number(String(pllMul).replace('×', ''));
  const sysclk = sws === 'PLL' ? (src === 'HSE' ? hse / (xtpre === 'HSE/2' ? 2 : 1) : 4) * mul
    : (sws === 'HSE' ? hse : 8);
  return { raw: '0x' + (v >>> 0).toString(16), sw, sws, pllSrc: src, pllXtp: xtpre, pllMul, sysclkMhz: sysclk };
}
try {
  await c.connect();
  c.onEvent = m => { if (m.method === 'Runtime.exceptionThrown') report.errors.push(m.params.exceptionDetails); };
  await c.send('Page.navigate', { url: 'http://127.0.0.1:8899/index.html?sram-96mhz=' + Date.now() + '#flash' });
  for (let i = 0; i < 150; i++) { if (await c.eval('return !!window.__tools?.flash;').catch(() => false)) break; await sleep(100); }
  const pageReady = await c.eval('return !!window.__tools?.flash;');
  assert.equal(pageReady, true, '页面没起来（8899 服务 + 9333 浏览器）');
  await c.eval(`await __tools.probeManager.releaseOthers(null,'SRAM 96MHz 实测');
    document.getElementById('f-chip').value='stm32f103';document.getElementById('f-chip').dispatchEvent(new Event('change'));
    document.getElementById('f-backend').value='webusb';document.getElementById('f-backend').dispatchEvent(new Event('change'));
    document.getElementById('f-ram-address').value='0x20000000';
    document.getElementById('f-ram-length').value='20480';
    document.getElementById('f-side-sram-tab').click();return true;`);

  // 先做活性检查（证明靶子固件在跑、g_ms 在走），**再**取基准快照：
  // 顺序反了的话，跑过 600 ms 的核会停在不同 PC，后面的寄存器对比必然失败。
  const run1 = await c.eval(probeOpen + `try{await p.halt();const before=await p._readWord(0x20000008)>>>0;await p.run();await new Promise(r=>setTimeout(r,600));await p.halt();const after=await p._readWord(0x20000008)>>>0;return {before,after};}finally{await p.disconnect();}`);
  report.gMsProgress = run1;   // 96 MHz 固件的 g_ms 每毫秒 +1
  // 靶子身份与时钟：CPUID / RCC_CFGR（PLL ×12 + HSE）/ 复位向量 / 基准寄存器快照
  const id1 = await c.eval(probeOpen + `try{await p.halt();
      const regs=[];for(let i=0;i<17;i++)regs.push(await p.regRead(i));
      const vectors=[];for(let i=0;i<8;i++)vectors.push(await p._readWord(0x08000000+i*4));
      return {regs,cpuid:await p._readWord(0xe000ed00)>>>0,cfgr:await p._readWord(0x40021004)>>>0,
              vectors,gBytes:await p._readWord(0x20000000)>>>0,gMs:await p._readWord(0x20000008)>>>0};}finally{await p.disconnect();}`);
  report.initial = { ...id1, cfgrDecoded: decodeCfgr(id1.cfgr) };
  console.log('初始：CFGR=' + JSON.stringify(report.initial.cfgrDecoded) + ' CPUID=0x' + id1.cpuid.toString(16)
    + ' g_ms ' + run1.before + '→' + run1.after);

  for (let repeat = 0; repeat < REPEATS; repeat++) {
    for (const khz of KHZ) {
      let result, error;
      try {
        result = await c.eval(`document.getElementById('f-ram-clock').value='${khz}'; return await __tools.flash.benchmarkSram();`);
      } catch (e) { error = e.message; }
      const after = await c.eval(probeOpen + `try{const halted=!!((await p._readWord(0xe000edf0))&(1<<17));const regs=[];for(let i=0;i<17;i++)regs.push(await p.regRead(i));return {halted,regs,cfgr:await p._readWord(0x40021004)>>>0};}finally{await p.disconnect();}`);
      assert.equal(after.halted, true, '基准跑完 CPU 应仍暂停');
      assert.deepEqual(after.regs, report.initial.regs, '体系寄存器不应变化');
      assert.equal(after.cfgr, report.initial.cfgr, 'RCC 不应变化（靶子主频保持 96 MHz）');
      const row = { repeat, requestedKhz: khz, result, error, cpuKeptHalted: true, registersPreserved: true, targetClockUnchanged: true };
      report.cases.push(row);
      writeFileSync(new URL('sram-96mhz.json', out), JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ repeat, requestedKhz: khz, got: result?.clockKhz, verified: result?.verified,
        readRate: result?.readRate && +result.readRate.toFixed(3), writeRate: result?.writeRate && +result.writeRate.toFixed(3),
        transport: result?.transport, error }));
      if (result) { assert.equal(result.verified, true, '每组都必须校验通过'); assert.equal(result.passes, 3); assert.equal(result.size, 20480); if (khz) assert.equal(result.clockKhz, khz); }
      else assert.ok(error, '既没有结果也没有错误');
    }
  }
  if (report.cases.slice(-16).every(x => x.result?.verified)) {
    writeFileSync(new URL('sram-96mhz-60mhz.png', out), Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  }
  const ok = report.cases.filter(x => x.result?.verified).length;
  const auto = report.cases.filter(x => x.requestedKhz === 0).map(x => x.result?.clockKhz);
  report.summary = { groups: report.cases.length, verified: ok, autoPicks: auto };
  assert.deepEqual(report.errors, []);
  assert.equal(ok, REPEATS * KHZ.length, '24 组应全部校验通过');
  report.passed = true;
  console.log('SUMMARY ' + JSON.stringify(report.summary));
} catch (e) {
  report.error = e.stack;
  process.exitCode = 1;
  console.error(e.stack);
} finally {
  writeFileSync(new URL('sram-96mhz.json', out), JSON.stringify(report, null, 2));
  c.close();
}

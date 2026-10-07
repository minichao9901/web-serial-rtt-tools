// Real WebUSB benchmark. Requires a matching known F103/HPM scope image and an authorized probe.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { Cdp, sleep } from '../selftest/cdp-lib.mjs';
import {checkHpmFrame} from './hpm-scope-contract.mjs';

const out = resolve(process.argv[2] || 'tmp/hss-web-bench.json');
const cases = JSON.parse(process.argv[3] || '[{"period":2,"draw":true},{"period":2,"draw":false},{"period":2.25,"draw":true},{"period":2.5,"draw":true}]');
const seconds = Number(process.argv[4]) || 5;
const elfPath = process.env.SCOPE_ELF || 'tools/target-firmware/stm32f103_scope/build-cb/fw.elf';
const c = new Cdp(process.env.CDP, 90000);
const app = process.env.APP || 'http://127.0.0.1:8899/index.html';
const clockKhz = (Number(process.env.SCOPE_CLOCK_MHZ) || 60) * 1000;
const target = process.env.SCOPE_TARGET || 'swd';
if(!['swd','riscv'].includes(target))throw Error('Invalid SCOPE_TARGET');
const contractName = process.env.SCOPE_CONTRACT || (target === 'riscv' ? 'g_v.u_hi' : 'g_pack.u_hi');
if(!['g_v.u_hi','g_pack.u_hi','g_v_hi.tick'].includes(contractName))throw Error('Unknown fixture contract');
const highTick=contractName==='g_v_hi.tick';
const results = { startedAt: new Date().toISOString(), elfPath, target, contractName, seconds, rows: [] };
mkdirSync(dirname(out), { recursive: true });
await c.connect();
try {
  await c.send('Page.navigate', { url: app + '?hssbench=' + Date.now() + '#scope' });
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    if (await c.eval('return !!window.__tools?.scope;').catch(() => false)) break;
  }
  await c.eval(`
    const s=window.__tools.scope;
    await s.setMock(false);
    await s.connectHid(false);
    await s.connectUsb(false);
    if(!s.hid||!s.transport)throw Error('Probe must already be authorized in this profile');
    document.getElementById('sc-target').value=${JSON.stringify(target)}; await s.applyTargetType();
    const b=Uint8Array.from(atob(${JSON.stringify(readFileSync(elfPath).toString('base64'))}),c=>c.charCodeAt(0));
    await s.loadElfFile(new File([b],${JSON.stringify(basename(dirname(elfPath))+'-scope.elf')}));
    s.selected=[]; const contract=s.all.find(v=>v.name===${JSON.stringify(contractName)});
    if(!contract)throw Error('Missing contract variable');s.toggleVar(contract,true);
    document.getElementById('sc-clock').value=${JSON.stringify(String(clockKhz))};
    document.getElementById('sc-cdcoff').checked=true;
    document.getElementById('sc-batch').checked=true;
    document.getElementById('sc-raw').checked=false; s.captureRaw=false;
    window.__benchOriginalDraw=s.drawFrame;
    window.__benchSnap=async()=>{
      const r=await s.hidXfer(0x32,Uint8Array.of(11));
      if(!r||r.length<51)throw Error('No full-width probe metrics');
      const d=new DataView(r.buffer,r.byteOffset,r.byteLength),w=Array.from({length:12},(_,i)=>d.getUint32(3+i*4,true));
      if(w[0]!==0x31535348||w[2]!==24000000)throw Error('Bad metrics');
      return {w,count:s.store.count,bytes:s.transport.bytes,host:performance.now()};
    };
    return true;
  `, true);
  results.calibration=await c.eval('const s=window.__tools.scope;await s.bench();return {readUs:s.benchUs,recommendedUs:s.recPeriodUs,fresh:s.benchFresh(),status:s.state};');
  if(!results.calibration.fresh)throw Error('Read calibration failed: '+results.calibration.status);
  for (const cfg of cases) {
    const row = await c.eval(`
      const s=window.__tools.scope,cfg=${JSON.stringify(cfg)};
      document.getElementById('sc-batch').checked=cfg.batch!==false;
      if(cfg.vars){
        s.selected=[];for(const name of cfg.vars){const v=s.all.find(v=>v.name===name);if(!v)throw Error('Missing variable '+name);s.toggleVar(v,true);}
        await s.bench();if(!s.benchFresh())throw Error('Plan calibration failed');
      }
      if(!s.benchFresh()){await s.bench();if(!s.benchFresh())throw Error('Plan calibration failed');}
      const calibration={readUs:s.benchUs,recommendedUs:s.recPeriodUs,fresh:s.benchFresh()};
      s.drawFrame=cfg.draw?window.__benchOriginalDraw:function(){};
      s.transport._adaptiveReadAhead=!!cfg.adaptive;
      s.transport.inFlight=cfg.depth||3; s.transport.chunkBytes=cfg.readSize||4096;
      document.getElementById('sc-period').value=String(cfg.period);
      document.getElementById('sc-seconds').value=String(${seconds}+5);
      await s.start(); if(!s.running)throw Error(document.getElementById('sc-state').textContent);
      await new Promise(r=>setTimeout(r,500));
      const a=await window.__benchSnap();let last=performance.now(),maxLag=0;
      const timer=setInterval(()=>{const now=performance.now();maxLag=Math.max(maxLag,now-last-20);last=now;},20);
      const stallTimer=cfg.stallMs?setInterval(()=>{const until=performance.now()+cfg.stallMs;while(performance.now()<until){};},cfg.stallEveryMs||500):null;
      await new Promise(r=>setTimeout(r,${seconds}*1000));
      const b=await window.__benchSnap();clearInterval(timer);
      if(stallTimer)clearInterval(stallTimer);
      const valid=s.running&&s._capturing&&!!(b.w[11]&256)&&s.backend===${JSON.stringify(target)};
      const delta=(i)=>(b.w[i]-a.w[i])>>>0,dt=delta(1)/24000000;
      const stable={dt,produced:delta(3),skipped:delta(4),usb:delta(5),errors:delta(6),yields:delta(7),
        received:s.store.count-a.count,probeHz:delta(3)/dt,webHz:(s.store.count-a.count)/(b.host-a.host)*1000,
        dropPercent:(delta(4)+delta(5))/Math.max(1,delta(3)+delta(4)+delta(5))*100,maxMainThreadLagMs:maxLag};
      const count=s.store.count; await s.stop('硬件速率对照');
      const channelIndex=[...s.selected].sort((a,b)=>a.addr-b.addr).findIndex(v=>v.name===${JSON.stringify(contractName)});
      if(channelIndex<0)throw Error('Every benchmark case must contain the contract variable for integrity checks');
      const ch=s.store.channel(channelIndex);let bad=0,counterBackwards=0,maxCounterStep=0,previous=null;const firstBad=[];
      const selected=[...s.selected].sort((a,b)=>a.addr-b.addr);
      const waveformChannels=selected.map((v,j)=>({name:v.name,ch:s.store.channel(j)}));
      const checkFrame=${checkHpmFrame.toString()};let waveformBad=0,tornFrames=0,phaseOutliers=0;const phaseSkewCounts={};
      // A diagnostic budget for non-atomic paired reads, not a promise that
      // average M0 bounds IRQ latency. Preserve the observed phase histogram.
      const hiPhaseBudget=Math.ceil(calibration.readUs/5)+1;
      for(let i=0;i<count;i++){
        const v=ch.at(i);if(!${highTick}&&(v&0xffff0000)!==0x10000000){bad++;if(firstBad.length<8)firstBad.push({i,v});}
        if(previous!==null){const step=${highTick}?(v-previous)>>>0:(v-previous)&0xffff;if(step>${highTick?2147483648:32768})counterBackwards++;else maxCounterStep=Math.max(maxCounterStep,step);}
        previous=v;
        if(${JSON.stringify(target)}==='riscv'&&selected.some(v=>v.name==='g_v.tick'||v.name==='g_v_hi.tick')){
          const frame=Object.fromEntries(waveformChannels.map(v=>[v.name,v.ch.at(i)]));
          const checked=checkFrame(frame,hiPhaseBudget);waveformBad+=Number(checked.bad);tornFrames+=Number(checked.torn);phaseOutliers+=Number(!!checked.phaseOutlier);
          if(checked.phaseSkew!=null)phaseSkewCounts[checked.phaseSkew]=(phaseSkewCounts[checked.phaseSkew]||0)+1;
          if(checked.bad&&firstBad.length<8)firstBad.push({i,...checked});
        }
      }
      return {cfg,valid,calibration,stable,samplesChecked:count,bad,waveformBad,tornFrames,phaseOutliers,hiPhaseBudget,phaseSkewCounts,counterBackwards,maxCounterStep,firstBad,summary:s.summary(),stalePackets:s.stalePackets,
        readAhead:{depth:s.transport.inFlight,bytes:s.transport.chunkBytes},
        requestedUs:cfg.period,effectiveUs:s._periodUs,actualUs:s.periodActualUs,
        advice:document.getElementById('sc-rate-advice')?.textContent,
        periodTicks:b.w[10],flags:b.w[11],sequenceReordered:s.seqT.reordered};
    `);
    results.rows.push(row);
    writeFileSync(out, JSON.stringify(results, null, 2) + '\n');
    console.log(JSON.stringify({ cfg: row.cfg, valid: row.valid, ...row.stable, bad: row.bad, checked: row.samplesChecked,
      counterBackwards:row.counterBackwards,maxCounterStep:row.maxCounterStep,reordered:row.sequenceReordered, periodTicks:row.periodTicks }));
    if(!row.valid || row.bad || row.waveformBad || row.counterBackwards || row.sequenceReordered || row.stable.errors)
      throw Error('Invalid capture or sample integrity failure; evidence saved at '+out);
    await sleep(500);
  }
} finally {
  await c.eval('const s=window.__tools.scope;await s.stop();if(window.__benchOriginalDraw)s.drawFrame=window.__benchOriginalDraw;return true;').catch(() => {});
  c.close();
}

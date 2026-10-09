import assert from 'node:assert/strict';import{readFileSync}from'node:fs';import{createHash}from'node:crypto';import{unpackRecording,packRecording}from'../../app/swo/recording.js';import{analyzeTrace}from'../../app/swo/analyze.js';import{stageOracle}from'./swo-stage-oracle.mjs';
const elf=readFileSync('tools/target-firmware/stm32f103cb_swo/fw.elf'),sha=createHash('sha256').update(elf).digest('hex');
for(const [name,branch,overflow]of [['f103cb-route-b', 'b',false],['f103cb-route-a-fast','a',false],['f103cb-overflow','a',true]]){
 const blob=readFileSync('samples/swo/'+name+'.swopc'),r=unpackRecording(blob);const plan=r.metadata.plan,cfg=r.metadata.configReadback;assert.equal(cfg.dwt&0x11fe1,1|(plan.post<<5)|(plan.tap<<9)|(1<<10)|(1<<12)|(plan.exceptions?(1<<16):0),'real DWT readback confirms sampling settings');assert.equal(r.metadata.elfSha256,sha,'sample and published ELF stay paired');assert.deepEqual(packRecording(r.raw,r.metadata),new Uint8Array(blob));
 const a=analyzeTrace(r.raw,r.metadata,elf),names=a.hotspots.map(x=>x.fn),stage=stageOracle(a);assert.ok(a.pcSamples.length>4000);assert.equal(a.stats.malformed,0);assert.equal(a.stats.mapped,a.stats.analyzedSamples);assert.equal(!!a.stats.overflow,overflow);assert.ok(names.includes('branch_leaf_'+branch));assert.ok(!names.includes('branch_leaf_'+(branch==='a'?'b':'a')));assert.ok(!names.includes('never_path'));assert.ok(stage.checked>1000);assert.equal(stage.mismatchCount,0);
 const withGap=analyzeTrace(r.raw,{...r.metadata,transportGaps:[{offset:5000,reason:'test injected disconnect'}]},elf);assert.ok(withGap.stats.skippedBytes>0,'transport failure waits for real sync');assert.ok(withGap.pcSamples.length<a.pcSamples.length);assert.ok(withGap.events.some(e=>e.kind==='gap'&&e.reason.includes('disconnect')));
 console.log(name+': '+a.pcSamples.length+' real PCs mapped, '+stage.checked+' independent stage checks, explicit gaps '+a.stats.overflow+' PASS');
}

const mark=(p,cycles)=>({kind:'itm',port:1,value:(0xa5000000|p)>>>0,cycles,segment:0,timeQuality:'delayed'}),pc=(cycles,quality='delayed')=>({kind:'pc',fn:'branch_leaf_a',cycles,segment:0,timeQuality:quality});
assert.equal(stageOracle({events:[mark(3,100),mark(5,200),pc(200)]}).ambiguousCount,1,'same delayed timestamp group has no unique cross-source order');
assert.equal(stageOracle({events:[mark(3,100),mark(5,200),pc(300)]}).mismatchCount,1,'different timestamps never excuse wrong stage');
assert.equal(stageOracle({events:[mark(3,100),mark(5,200),{...pc(200),fn:'branch_leaf_b'}]}).mismatchCount,1,'wrong branch is never hidden as ambiguity');

const boundary=JSON.parse(readFileSync("samples/swo/delayed-boundary.json"));assert.equal(stageOracle(boundary).ambiguousCount,1,"real delayed boundary is preserved as unordered");assert.equal(stageOracle(boundary).mismatchCount,0);

// Keep the independently built HSE image paired with its real hardware recording.
const hseElf=readFileSync('tools/target-firmware/stm32f103cb_swo_hse/fw.elf'),hseRecord=unpackRecording(readFileSync('samples/swo/f103cb-hse72-1m.swopc'));
assert.equal(hseRecord.metadata.elfSha256,createHash('sha256').update(hseElf).digest('hex'));
assert.equal(hseRecord.metadata.target.source,'HSE → PLL');assert.equal(hseRecord.metadata.target.coreHz,72000000);assert.equal(hseRecord.metadata.plan.baudRate,1000000);assert.equal(hseRecord.metadata.configReadback.acpr,71);
const hseModel=analyzeTrace(hseRecord.raw,hseRecord.metadata,hseElf),hseStages=stageOracle(hseModel);
assert.equal(hseModel.stats.pc,15241);assert.equal(hseModel.stats.unmapped,0);assert.equal(hseModel.stats.overflow,0);assert.equal(hseModel.stats.malformed,0);assert.equal(hseModel.stats.truncated,0);assert.equal(hseStages.mismatchCount,0);assert.equal(hseStages.checked,14967);
console.log('f103cb-hse72-1m: real HSE 72 MHz record/ELF and 14967 stage checks PASS');

// Dense 64-cycle trace stays paired with the cooperative clock fixture.
const clockElf=readFileSync('tools/target-firmware/stm32f103cb_swo_clock/fw.elf'),clockRecord=unpackRecording(readFileSync('samples/swo/f103cb-clock240-64.swopc'));
assert.equal(clockRecord.metadata.elfSha256,createHash('sha256').update(clockElf).digest('hex'));
assert.equal(clockRecord.metadata.plan.periodCycles,64);assert.equal(clockRecord.metadata.plan.timestamps,false);assert.equal(clockRecord.metadata.target.coreHz,24000000);assert.equal(clockRecord.metadata.receiver.uartHz,240000000);assert.equal(clockRecord.metadata.receiver.actualBaud,24000000);assert.equal(clockRecord.metadata.receiver.osr,10);
assert.equal(clockRecord.metadata.restored,true);assert.equal(clockRecord.metadata.receiverRestored,true);assert.equal(clockRecord.metadata.targetClockRestored,true);assert.ok(Object.values(clockRecord.metadata.receiverErrors).every(n=>n===0));
const clockModel=analyzeTrace(clockRecord.raw,clockRecord.metadata,clockElf);
assert.equal(clockModel.stats.pc,105557);assert.equal(clockModel.stats.mapped,105557);assert.equal(clockModel.stats.unmapped,0);assert.equal(clockModel.stats.malformed,0);assert.equal(clockModel.stats.overflow,0);assert.equal(clockModel.stats.truncated,0);assert.equal(clockModel.stats.itm,0);assert.ok(clockModel.hotspots.some(x=>x.fn==='branch_leaf_a'));assert.ok(!clockModel.hotspots.some(x=>x.fn==='branch_leaf_b'||x.fn==='never_path'));
console.log('f103cb-clock240-64: 105557 real dense PCs, exact 24 Mbaud /240 MHz, receiver/target restored PASS');

import assert from 'node:assert/strict';
import { summaryTable } from './campaign-summary.mjs';
const spec = { flashFloodS: 12, flashScopeS: 12, viewerKBps: 56.5, fwdMBps: 1.101,
  recordBytesRatio: .98, j1kHz: 206.6, j3kHz: 32.6 };
const report = cycles => ({ cycles, spec, errors: [] });
let n = 0;
const empty = summaryTable(report([]));
assert.equal((empty.match(/PASS/g) || []).length, 0);
assert.match(empty, /0 通过 \/ 0 失败/); n++;
const partial = summaryTable(report([{ flashFlood: { ms: 4200 } }]));
assert.equal((partial.match(/PASS/g) || []).length, 1);
assert.match(partial, /RTT Viewer[^\n]*未测/); n++;
const cycle = { flashFlood: { ms: 4200 }, flashScope: { ms: 4500 },
  viewer: { kbps: 60, corrupt: 0, lost: 0 }, fwd: { rateMB: 1.38, record: { ratio: .996, fileBytes: 14000000 } },
  j1: { rateHz: 298000 }, j3: { rateHz: 51600 },
  j50k1: { samples: 150000, lostProbe: 0, lostUsb: 0 }, j50k3: { samples: 100000, lostProbe: 0, lostUsb: 0 } };
assert.equal((summaryTable(report([cycle])).match(/PASS/g) || []).length, 9); n++;
assert.match(summaryTable(report([cycle, {}])), /RTT Viewer[^\n]*未测/); n++;
assert.match(summaryTable(report([{ ...cycle, viewer: { ...cycle.viewer, corrupt: 1 } }])), /错位读[^\n]*FAIL/); n++;
assert.match(summaryTable(report([{ ...cycle, j50k3: undefined }])), /低速率档[^\n]*未测/); n++;
assert.match(summaryTable(report([{ ...cycle, j50k3: { ...cycle.j50k3, lostUsb: 1 } }])), /低速率档[^\n]*FAIL/); n++;
assert.match(summaryTable(report([{ ...cycle, j50k3: { ...cycle.j50k3, lostProbe: 100 } }])), /低速率档[^\n]*FAIL/); n++;
console.log(`Campaign summary: ${n} passed`);

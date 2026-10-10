import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boardMatrix, diskPath, repoRoot } from './board-matrix.mjs';

const active = Object.entries(boardMatrix.boards).filter(([, b]) => b.status === 'active');
const requireBuilds = process.env.REQUIRE_BUILDS === '1';
assert.deepEqual(active.map(([id]) => id), ['f103cb', 'f103ze', 'h743', '6800evk', '5301evklite']);

for (const [id, board] of active) {
  assert.ok(board.label && board.chip && board.target, `${id}: 板卡基本字段缺失`);
  assert.ok(board.examples, `${id}: 没有例程表`);
  for (const example of ['rtt', 'scope', 'dbgstress']) {
    const item = board.examples[example];
    assert.ok(item, `${id}/${example}: 缺少例程`);
    assert.ok(fs.existsSync(diskPath(item.project)), `${id}/${example}: project 不存在 ${item.project}`);
    assert.ok(fs.existsSync(diskPath(item.script)), `${id}/${example}: build script 不存在 ${item.script}`);
    assert.ok(item.buildArtifact.includes('/build'), `${id}/${example}: buildArtifact 必须指向构建目录`);
    if (requireBuilds) {
      assert.ok(fs.existsSync(diskPath(item.buildArtifact)), `${id}/${example}: 未找到构建产物 ${item.buildArtifact}（先运行 make build-all-examples）`);
    }
    if (item.publishedArtifact) {
      assert.ok(fs.existsSync(diskPath(item.publishedArtifact)), `${id}/${example}: 未找到发布产物 ${item.publishedArtifact}`);
    }
    assert.ok(path.relative(repoRoot, diskPath(item.buildArtifact)).split(path.sep)[0] === 'tools', `${id}/${example}: 产物越出仓库 tools 目录`);
  }
  if (id.startsWith('f103')) assert.match(board.viewerRange, /^0x20000000-0x[0-9a-f]+$/i);
  if (id === 'h743') assert.match(board.viewerRange, /^0x24000000-/i);
  if (id === '5301evklite') assert.match(board.viewerRange, /^0x00080000-0x00090000$/i);
  for (const name of ['spi-echo', 'spi-dma', 'spi-master-dma']) {
    if (!board.examples[name]) continue;
    assert.equal(board.target, 'riscv', `${id}: ${name} 只用于 HPM/RISC-V fixture`);
    const item = board.examples[name];
    for (const field of ['project', 'script', 'buildArtifact', 'publishedArtifact']) assert.ok(item[field], `${id}/${name}: 缺少 ${field}`);
    assert.ok(fs.existsSync(diskPath(item.project)), `${id}/${name}: project 不存在 ${item.project}`);
    assert.ok(fs.existsSync(diskPath(item.script)), `${id}/${name}: build script 不存在 ${item.script}`);
    if (requireBuilds) assert.ok(fs.existsSync(diskPath(item.buildArtifact)), `${id}/${name}: 未找到构建产物 ${item.buildArtifact}`);
    assert.ok(fs.existsSync(diskPath(item.publishedArtifact)), `${id}/${name}: 未找到发布产物 ${item.publishedArtifact}`);
    assert.ok(path.relative(repoRoot, diskPath(item.buildArtifact)).split(path.sep)[0] === 'tools', `${id}/${name}: 产物越出仓库 tools 目录`);
  }
}

console.log(`board matrix ok: ${active.length} active boards / ${active.reduce((n, [, b]) => n + Object.keys(b.examples).length, 0)} examples${requireBuilds ? ' / builds present' : ''}`);

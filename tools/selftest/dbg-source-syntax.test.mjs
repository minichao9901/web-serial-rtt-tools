import assert from 'node:assert/strict';
import { sourceTokens } from '../../app/dbg/source-syntax.js';

const lines = [
  '#include "stdint.h"',
  '/* multiline comment',
  '  return 42; */ uint32_t count = 0x12u;',
  'const char *s = "<img onerror=alert(1)> // not a comment";',
  'char c = \'\\\'\'; // escaped character',
  'auto raw = R"tag(/* <script> int',
  'still a string)tag"; return .5e-2f;',
  '// continued comment \\',
  'return 1;',
  'const char *continued = "abc\\',
  'def"; while (count) work(count--);',
];
const tokens = sourceTokens(lines, 'main.cpp');
assert.deepEqual(tokens.map(row => row.map(t => t.text).join('')), lines, '源码逐字保留');
const has = (row, kind, text) => tokens[row].some(t => t.kind === kind && t.text.includes(text));
assert.ok(has(0, 'directive', '#include'));
assert.ok(has(2, 'comment', 'return 42;') && has(2, 'type', 'uint32_t') && has(2, 'number', '0x12u'));
assert.ok(has(3, 'string', '<img') && !tokens[3].some(t => t.kind === 'comment'));
assert.ok(has(4, 'string', "'\\''") && has(4, 'comment', 'escaped'));
assert.ok(has(5, 'string', '/* <script> int') && has(6, 'string', 'still a string') && has(6, 'number', '.5e-2f'));
assert.ok(has(8, 'comment', 'return 1;'));
assert.ok(has(10, 'string', 'def"') && has(10, 'keyword', 'while') && has(10, 'function', 'work'));
assert.equal(sourceTokens(['return 1;'], 'notes.txt'), null, '其他文件保留纯文本');
assert.ok(sourceTokens(['int value;'], 'main.c')[0].some(t => t.kind === 'type'), '切换文件不继承注释状态');
console.log('PASS: 源码保真、跨行注释/字符串、C++ raw string、转义、数字与文件隔离');

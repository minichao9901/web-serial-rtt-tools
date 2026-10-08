/** Independent oracle: compare loader relocation with a separately linked ELF binary. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {hpmAlgoBytes} from '../../../app/flash/hpm/algo.js';
const [path, address='0x4000'] = process.argv.slice(2);
if (!path) throw Error('usage: check-relocation.mjs <independently-linked.bin> [load-address]');
assert.deepEqual(new Uint8Array(await readFile(path)),hpmAlgoBytes(Number(address)));
console.log('Algorithm relocation: loader bytes equal independently linked binary, every byte PASS');

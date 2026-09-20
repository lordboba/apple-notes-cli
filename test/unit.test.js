import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInput, effectiveBindings, actionFor } from '../src/keys.js';
import { strWidth, truncate, wrap } from '../src/term.js';
import { sanitize } from '../src/store.js';

test('parseInput: arrows, ctrl, meta, SGR mouse', () => {
  assert.deepEqual(parseInput('\x1b[A\x1b[6~\x04\x1bv\r '), ['up', 'pagedown', 'ctrl+d', 'meta+v', 'enter', 'space']);
  assert.deepEqual(parseInput('\x1b[<0;10;5M\x1b[<0;10;5m'), [{ x: 10, y: 5 }]);
  assert.deepEqual(parseInput('\x1b[<64;1;1M\x1b[<65;1;1M'), ['wheelup', 'wheeldown']);
  assert.deepEqual(parseInput('\x1b'), ['escape']);
});

test('bindings: chords and user overrides', () => {
  const b = effectiveBindings({ keymap: 'hybrid', keys: { quit: ['x'] } });
  assert.equal(actionFor(b, 'g', null).pending, 'g');
  assert.equal(actionFor(b, 'g', 'g').action, 'top');
  assert.equal(actionFor(b, 'x', null).action, 'quit');
  assert.equal(actionFor(b, 'ctrl+n', null).action, 'down');
});

test('strWidth: CJK/emoji wide, dingbats narrow', () => {
  assert.equal(strWidth('日本'), 4);
  assert.equal(strWidth('📎🔒'), 4);
  assert.equal(strWidth('✳❯✓⚠'), 4);
  assert.equal(strWidth('✅❌'), 4);
  assert.equal(truncate('abcdef', 4), 'abc…');
});

test('wrap: hard-breaks long tokens and keeps blank lines', () => {
  const lines = wrap('a\n\n' + 'x'.repeat(25), 10);
  assert.deepEqual(lines, ['a', '', 'xxxxxxxxxx', 'xxxxxxxxxx', 'xxxxx']);
});

test('sanitize: strips terminal control sequences, keeps tab/newline', () => {
  assert.equal(sanitize('a\x1b[31mred\x1b[0m\tb\nc\x7f\x9b'), 'a[31mred[0m\tb\nc');
  assert.equal(sanitize('x\x1b]0;title\x07y'), 'x]0;titley');
  assert.equal(sanitize(null), '');
});

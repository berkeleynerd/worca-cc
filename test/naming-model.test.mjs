import test from 'node:test';
import assert from 'node:assert/strict';
import { pickNamingModel, estimateNamingUsd, resolveNamingModel } from '../src/core/naming.mjs';
import { DEFAULT_ENGINE } from '../src/shared/engine-switch.mjs';

const CLAUDE = { kind: 'signin', engine: 'claude' };
const row = (id, extra = {}) => ({ id, label: id, efforts: ['low', 'medium', 'high'], engine: 'claude', connection: CLAUDE, harnesses: ['claude'], ...extra });

test('the cheapest ready Claude model, at its lowest listed effort', () => {
  const rows = [row('claude-opus-5-5'), row('claude-haiku-5-5', { efforts: ['minimal', 'low'] }), row('claude-sonnet-5-5')];
  assert.deepEqual(pickNamingModel(rows, () => null), { model: 'claude-haiku-5-5', effort: 'minimal' });
});
test('a model that needs sign-in or is free is skipped', () => {
  const rows = [row('claude-haiku-5-5', { needsSignIn: true }), row('free-one'), row('claude-sonnet-5-5')];
  const costOf = (id) => (id === 'free-one' ? { free: true } : null);
  assert.equal(pickNamingModel(rows, costOf).model, 'claude-sonnet-5-5');
});
const CODEX = { kind: 'signin', engine: 'codex' };
const crow = (id, extra = {}) => row(id, { engine: 'codex', connection: CODEX, harnesses: ['codex'], ...extra });
test('the default harness (Codex) is preferred: its cheapest ready model at its lowest effort; Claude when it has none ready', () => {
  assert.equal(DEFAULT_ENGINE, 'codex');
  const rows = [row('claude-haiku-5-5', { efforts: ['minimal', 'low'] }), crow('gpt-6-astra'), crow('gpt-6-luna', { efforts: ['low', 'medium'] }), row('claude-opus-5-5')];
  assert.deepEqual(pickNamingModel(rows, () => null), { model: 'gpt-6-luna', effort: 'low' });
  assert.deepEqual(pickNamingModel(rows, () => null, 'claude'), { model: 'claude-haiku-5-5', effort: 'minimal' }, 'a Claude-default install keeps Claude');
  // Codex signed out, or only a free Codex model: the Claude pick, as before.
  const out = rows.map((r) => (r.engine === 'codex' ? { ...r, needsSignIn: true } : r));
  assert.deepEqual(pickNamingModel(out, () => null), { model: 'claude-haiku-5-5', effort: 'minimal' });
  assert.deepEqual(pickNamingModel(rows, (id) => (/^gpt-/.test(id) ? { free: true } : null)), { model: 'claude-haiku-5-5', effort: 'minimal' });
  // Only Codex ready: its model; nothing ready anywhere: null.
  assert.deepEqual(pickNamingModel([crow('gpt-6-astra'), crow('gpt-6-luna')], () => null, 'claude'), null, 'Claude preferred and no Claude model: no cross-harness pick');
  assert.deepEqual(pickNamingModel([crow('gpt-6-luna')], () => null), { model: 'gpt-6-luna', effort: 'low' });
});
test('a harness that runs no helper jobs is never preferred: its models are passed over for Claude\'s', () => {
  const CURSOR = { kind: 'signin', engine: 'cursor' };
  const rows = [row('cursor-fast', { engine: 'cursor', connection: CURSOR, harnesses: ['cursor'] }), row('claude-sonnet-5-5')];
  assert.deepEqual(pickNamingModel(rows, () => null, 'cursor'), { model: 'claude-sonnet-5-5', effort: 'low' });
});
test('resolveNamingModel with nothing stored follows the same preference', () => {
  const rows = [row('claude-haiku-5-5'), crow('gpt-6-luna')];
  assert.deepEqual(resolveNamingModel({ model: null, effort: null }, rows, () => null), { model: 'gpt-6-luna', effort: 'low', source: 'auto', stale: null });
  assert.deepEqual(resolveNamingModel({ model: 'claude-haiku-5-5', effort: 'medium' }, rows, () => null), { model: 'claude-haiku-5-5', effort: 'medium', source: 'settings', stale: null }, 'a stored Claude model wins');
});
test('nothing qualifies: null', () => {
  assert.equal(pickNamingModel([], () => null), null);
  assert.equal(pickNamingModel([row('claude-haiku-5-5', { needsSignIn: true })], () => null), null);
});
test('estimateNamingUsd prices about 300 tokens in and 30 out; null when unpriced', () => {
  const rows = [row('claude-haiku-5-5')];
  assert.ok(Math.abs(estimateNamingUsd({ model: 'claude-haiku-5-5' }, rows) - (300 * 0.1 + 30 * 0.5) / 1e6) < 1e-12);
  assert.equal(estimateNamingUsd({ model: 'nope' }, rows), null);
  assert.equal(estimateNamingUsd(null, rows), null);
});
test('resolveNamingModel: the stored pair while the catalog carries it, else the cheapest ready Claude model', () => {
  const rows = [row('claude-opus-5-5'), row('claude-haiku-5-5', { efforts: ['minimal', 'low'] }), row('claude-sonnet-5-5')];
  const unset = resolveNamingModel({ model: null, effort: null }, rows, () => null);
  assert.deepEqual(unset, { model: 'claude-haiku-5-5', effort: 'minimal', source: 'auto', stale: null });
  const set = resolveNamingModel({ model: 'CLAUDE-SONNET-5-5', effort: 'high' }, rows, () => null);
  assert.deepEqual(set, { model: 'claude-sonnet-5-5', effort: 'high', source: 'settings', stale: null }, 'catalog casing');
  const noEffort = resolveNamingModel({ model: 'claude-haiku-5-5', effort: 'high' }, rows, () => null);
  assert.equal(noEffort.effort, null, 'an effort the model does not offer is dropped');
  const stale = resolveNamingModel({ model: 'gone', effort: 'high' }, rows, () => null);
  assert.deepEqual(stale, { model: 'claude-haiku-5-5', effort: 'minimal', source: 'auto', stale: 'gone' });
  assert.deepEqual(resolveNamingModel({ model: 'gone' }, [], () => null), { model: null, effort: null, source: 'default', stale: 'gone' });
  assert.deepEqual(resolveNamingModel({ model: null }, [], () => null), { model: null, effort: null, source: 'default', stale: null });
});

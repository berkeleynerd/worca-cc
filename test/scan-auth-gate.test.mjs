// test/scan-auth-gate.test.mjs
// ui/server.mjs: both scan endpoints and agent generation refuse up front (409,
// code 'claude-signed-out') when `claude auth status` says signed out — nothing
// is started. Before, the scan ran its first phase and died ~30 s later with
// "claude exited with code 1: Not logged in".
// The refusal is for a job that runs on Claude: a scan on a Claude scan model, a generation on a Claude model. A job
// on another harness (Codex is the default: nothing stored scans and generates on it) is not Claude's sign-in to
// refuse; those cases are checked on the gate's own functions, so no codex run is started here.
//
// Real mode (no WORCA_MOCK) with WORCA_CLAUDE_BIN pointing at a fake `claude`
// shell script that answers `auth status` as signed out and fails everything
// else the way a signed-out CLI does (`unrecognized_model`, not "Not logged in"), so no real Claude is ever started.
// The run overview (a cached answer needs no Claude) maps that failure to the
// same 409 instead of probing up front. POSIX-only (a shell script as the bin).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { useTempHome } from './helpers/temp-home.mjs';
import { fakeCodex } from './helpers/fake-codex.mjs';
import { CLAUDE_AUTH_ENV_KEYS, CLAUDE_AUTH_ENV_FLAGS, clearClaudeAuthCache } from '../src/core/preflight.mjs';

const skip = process.platform === 'win32' ? 'the fake claude is a shell script' : false;

useTempHome(after);

const saved = {};
const ENV_KEYS = ['WORCA_MOCK', 'ORCH_MOCK', 'WORCA_CLAUDE_BIN', 'ORCH_CLAUDE_BIN', 'WORCA_CODEX_BIN', 'WORCA_TEST_ALLOW_HOME_FALLBACK', ...CLAUDE_AUTH_ENV_KEYS, ...CLAUDE_AUTH_ENV_FLAGS];
// db-seed and ui/server.mjs load claude-runner, whose default bin is read at import:
// both are imported only AFTER WORCA_CLAUDE_BIN points at the fake.
let srv, base, runs, scratch, seedPipeline, mod;
// A scan pick on a Claude model: the scan agent runs on the claude CLI.
const CLAUDE_SCAN = { scanModel: 'claude-sonnet-5', scanEffort: 'medium', agentModel: 'sonnet', agentEffort: 'medium' };
const JSONH = { 'Content-Type': 'application/json' };
const post = (p, body) => fetch(`${base}${p}`, { method: 'POST', headers: JSONH, body: JSON.stringify(body) });

async function repo(name) {
  const dir = join(scratch, name);
  const g = (a) => spawnSync('git', a, { cwd: dir });
  spawnSync('mkdir', ['-p', dir]);
  g(['init', '-q', '-b', 'main']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  await writeFile(join(dir, 'README.md'), '# hi\n');
  g(['add', '-A']); g(['commit', '-qm', 'init']);
  return dir;
}

before(async () => {
  if (skip) return;
  scratch = await mkdtemp(join(tmpdir(), 'worca-cc-scanauth-'));
  const bin = join(scratch, 'claude');
  await writeFile(bin, [
    '#!/bin/sh',
    'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then echo \'{"loggedIn": false}\'; exit 1; fi',
    // What a signed-out CLI really prints for a first-party id — not "Not logged in".
    'echo \'[claude-code:unrecognized_model] {"model":"claude-opus-5-5","query_source":"sdk"}\' >&2',
    'exit 1',
  ].join('\n') + '\n');
  await chmod(bin, 0o755);
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.WORCA_CLAUDE_BIN = bin;
  // The Agent generation setting is read from settings.json under HOME (a temp home here: useTempHome).
  process.env.WORCA_TEST_ALLOW_HOME_FALLBACK = '1';
  // A signed-out codex: every turn fails 401. engines/codex.mjs reads its bin at import, so it
  // is set here, before db-seed / ui/server.mjs load it.
  process.env.WORCA_CODEX_BIN = fakeCodex(scratch, null, { fail: '401 Unauthorized' }).bin;
  clearClaudeAuthCache();
  ({ seedPipeline } = await import('./helpers/db-seed.mjs'));
  mod = await import('../ui/server.mjs');
  runs = mod.runs;
  srv = mod.server;
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});

after(async () => {
  if (skip) return;
  if (srv) await new Promise((r) => srv.close(r));
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  clearClaudeAuthCache();
  await rm(scratch, { recursive: true, force: true });
});

// The scan is a pipeline run since PR #502 (wf_workspace_scan, a 'workspace-run' entry): "nothing
// started" means no run entry of ANY kind was registered — counting the retired kind 'scan' would
// pass even when the refusal is missing.
const entries = () => runs.size;

test('POST /api/workspaces/scan on a Claude scan model: signed-out Claude → 409 claude-signed-out, no scan started', { skip }, async () => {
  const before = entries();
  const a = await repo('a');
  const b = await repo('b');
  const r = await post('/api/workspaces/scan', { projectPaths: [a, b], name: 'Gate WS', models: CLAUDE_SCAN });
  assert.equal(r.status, 409);
  const body = await r.json();
  assert.equal(body.code, 'claude-signed-out');
  assert.match(body.error, /isn't signed in/);
  assert.match(body.error, /\/login/);
  assert.equal(body.runId, undefined);
  assert.equal(entries(), before, 'no run registered');
});

test('POST /api/workspaces/:id/scan (re-scan) on a Claude scan model: same refusal; with no model to scan on, the page is asked for one first', { skip }, async () => {
  const a = await repo('c');
  const b = await repo('d');
  const { workspace: created } = await (await post('/api/workspaces', { name: 'Gate Rescan WS', projectPaths: [a, b] })).json();
  assert.ok(created.id, JSON.stringify(created));
  const before = entries();
  const r = await post(`/api/workspaces/${encodeURIComponent(created.id)}/scan`, { models: CLAUDE_SCAN });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).code, 'claude-signed-out');
  // No stored pick and none named: which harness would run is not known yet, so the answer is "choose a model".
  const ask = await post(`/api/workspaces/${encodeURIComponent(created.id)}/scan`, {});
  assert.equal(ask.status, 428);
  assert.equal((await ask.json()).code, 'SCAN_MODEL_REQUIRED');
  assert.equal(entries(), before, 'no run registered');
});

test('POST /api/agents/generate with a Claude model set for Agent generation: same refusal, no generation started', { skip }, async () => {
  const set = await post('/api/settings', { agentGenModel: { model: 'claude-opus-5-5' } });
  assert.equal(set.status, 200, await set.clone().text());
  try {
    assert.deepEqual([(await mod.agentGenTarget()).pick.model, (await mod.agentGenTarget()).engine], ['claude-opus-5-5', null]);
    const r = await post('/api/agents/generate', { name: 'Gate Agent', purpose: 'p' });
    assert.equal(r.status, 409);
    assert.equal((await r.json()).code, 'claude-signed-out');
    assert.equal([...runs.values()].filter((e) => e.kind === 'agentgen').length, 0);
  } finally {
    await post('/api/settings', { agentGenModel: null });
  }
});

test('the gate follows the harness: a signed-out Claude refuses only a job that runs on Claude', { skip }, async () => {
  const stub = () => ({ code: null, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
  // refuseSignedOutClaude: no engine named is Claude (the callers that are Claude-only); another harness is never refused.
  let res = stub();
  assert.equal(await mod.refuseSignedOutClaude(res), true);
  assert.deepEqual([res.code, res.body.code], [409, 'claude-signed-out']);
  res = stub();
  assert.equal(await mod.refuseSignedOutClaude(res, { engine: 'claude' }), true);
  assert.equal(res.code, 409);
  res = stub();
  assert.equal(await mod.refuseSignedOutClaude(res, { engine: 'codex' }), false);
  assert.deepEqual([res.code, res.body], [null, null], 'nothing was sent');
  // scanRunEngine: the harness of the scan model; with no model, the run engine a workspace run defaults to.
  assert.equal(mod.scanRunEngine(CLAUDE_SCAN), 'claude');
  assert.equal(mod.scanRunEngine({ ...CLAUDE_SCAN, scanModel: 'gpt-6.1-sol' }), 'codex');
  assert.equal(mod.scanRunEngine({ needsModel: true, models: [] }), 'codex');
  assert.equal(mod.scanRunEngine(null), 'codex');
  // Nothing stored: a scan picks the default harness's model, so it starts on Codex and is not refused here.
  const picked = await mod.scanModelsFor({}, [await repo('i'), await repo('j')]);
  assert.deepEqual(picked, { scanModel: 'gpt-6.1-sol', scanEffort: 'medium', agentModel: 'sonnet', agentEffort: 'medium', source: 'settings', warning: null });
  assert.equal(mod.scanRunEngine(picked), 'codex');
  // Nothing stored for Agent generation: it generates on the default harness.
  const target = await mod.agentGenTarget();
  assert.deepEqual([target.pick.model, target.engine], [null, 'codex']);
});

test('POST /api/runs/:id/overview: a signed-out CLI failure → 409 claude-signed-out, not a raw 500', { skip }, async () => {
  const proj = await repo('e');
  const { id, key } = await seedPipeline(proj, { title: 'overview', status: 'done' });
  const r = await fetch(`${base}/api/runs/${id}/overview?key=${encodeURIComponent(key)}`, { method: 'POST' });
  const body = await r.json();
  assert.equal(r.status, 409, JSON.stringify(body));
  assert.equal(body.code, 'claude-signed-out');
  assert.match(body.error, /isn't signed in/);
});

test('POST /api/runs/:id/overview of a Codex run: codex\'s own error, never the Claude sign-in 409 (Review Focus 5)', { skip }, async () => {
  const proj = await repo('g');
  const { id, key } = await seedPipeline(proj, { title: 'overview codex', status: 'done', engine: 2, runEngine: 'codex' });
  const r = await fetch(`${base}/api/runs/${id}/overview?key=${encodeURIComponent(key)}`, { method: 'POST' });
  const body = await r.json();
  assert.equal(r.status, 500, JSON.stringify(body));
  assert.equal(body.code, undefined);
  assert.match(body.error, /401 Unauthorized/);
});

test('POST /api/pr/describe of a Codex run: codex\'s own error, never the Claude sign-in 409', { skip }, async () => {
  const proj = await repo('h');
  const { id, key } = await seedPipeline(proj, { title: 'pr codex', status: 'done', engine: 2, runEngine: 'codex' });
  const r = await post('/api/pr/describe', { id, projectKey: key });
  const body = await r.json();
  assert.equal(r.status, 500, JSON.stringify(body));
  assert.equal(body.code, undefined);
  assert.match(body.error, /401 Unauthorized/);
});

test('GET /api/onboarding: signed-out Claude is not ticked; ?recheck=1 answers the same', { skip }, async () => {
  for (const q of ['', '?recheck=1']) {
    const s = await (await fetch(`${base}/api/onboarding${q}`)).json();
    assert.equal(s.claude.auth, 'signed-out');
    assert.equal(s.steps.claude, false);
  }
});

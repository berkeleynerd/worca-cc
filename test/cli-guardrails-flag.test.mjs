// test/cli-guardrails-flag.test.mjs — `worca --guardrails <id>` (G13 follow-up).
// A fresh install defaults to the Normal set. Codex, the default harness, starts on it and names the rules
// it does not hold; Cursor cannot hold them and refuses, as Codex does on Secure. So the CLI needs a way to
// pick the set a run uses: --guardrails names it, an unknown id fails before any run starts, and the
// engine gate's refusal tells a CLI user which flag lifts it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useTempHome } from './helpers/temp-home.mjs';
import { engineRefusalFor } from '../src/shared/engine-switch.mjs';

const CLI = resolve(fileURLToPath(import.meta.url), '..', '..', 'src', 'cli', 'worca-cc.mjs');
const home = useTempHome(after);
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function project() {
  const d = mkdtempSync(join(tmpdir(), 'worca-cli-guardrails-'));
  dirs.push(d);
  execSync('git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', { cwd: d });
  return d;
}
// HOME too: settings.json resolves under HOME, not WORCA_HOME. No store_meta row: a fresh install (Normal).
const cli = (args) => spawnSync(process.execPath, [CLI, ...args], {
  encoding: 'utf8', timeout: 120_000,
  env: { ...process.env, WORCA_HOME: home, HOME: home, USERPROFILE: home, WORCA_MOCK: '' },
});

test('--help lists --guardrails', () => {
  const r = cli(['--help']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /--guardrails <id>/);
});

test('a fresh install starts a plain run: Codex on Normal, no flag, and the log names the rules Codex does not hold', () => {
  for (const engine of [[], ['--engine', 'codex']]) {
    const r = cli(['--project', project(), '--prompt', 'x', '--mock', '--yes', ...engine]);
    assert.equal(r.status, 0, `${engine.join(' ')}: ${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /engine codex: guardrail set "normal": rules NOT enforced on codex .*Read\(\.env\*\)/);
    assert.match(r.stdout, /engine codex: deny rules held on codex only in part, as command rules .*Bash\(git push\)/);
    assert.doesNotMatch(r.stdout + r.stderr, /has permission rules this engine cannot enforce/);
  }
});

test('a fresh install still refuses Codex on Secure and Cursor on Normal, and names the flag that picks Permissive', () => {
  const secure = cli(['--project', project(), '--prompt', 'x', '--mock', '--yes', '--engine', 'codex', '--guardrails', 'secure']);
  assert.notEqual(secure.status, 0);
  assert.match(secure.stdout + secure.stderr, /guardrail set "secure" has permission rules this engine cannot enforce .* — run it with --guardrails permissive, or pass --allow-unguarded-engine/);
  const cursor = cli(['--project', project(), '--prompt', 'x', '--mock', '--yes', '--engine', 'cursor']);
  assert.notEqual(cursor.status, 0);
  assert.match(cursor.stdout + cursor.stderr, /guardrail set "normal" has permission rules this engine cannot enforce .* — run it with --guardrails permissive, or pass --allow-unguarded-engine/);
});

test('--guardrails permissive runs a Codex project on a fresh install without --allow-unguarded-engine', () => {
  for (const flag of [['--guardrails', 'permissive'], ['--guardrails=permissive']]) {
    const r = cli(['--project', project(), '--prompt', 'x', '--mock', '--yes', '--engine', 'codex', ...flag]);
    assert.equal(r.status, 0, `${flag.join(' ')}: ${r.stdout}\n${r.stderr}`);
    assert.doesNotMatch(r.stdout + r.stderr, /cannot enforce/);
  }
});

test('an unknown --guardrails id exits 2 before a run starts', () => {
  const r = cli(['--project', project(), '--prompt', 'x', '--mock', '--yes', '--guardrails', 'nope']);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /worca: unknown guardrail set "nope"/);
  assert.doesNotMatch(r.stdout, /orchestrator — project/, 'no run was started');
  const bare = cli(['--prompt', 'x', '--guardrails']);
  assert.equal(bare.status, 2);
  assert.match(bare.stderr, /Flag --guardrails requires a value/);
});

test('the UI and chat word the Permissive hint as the set, never the CLI flag', () => {
  const cliText = 'engine codex: guardrail set "normal" has permission rules this engine cannot enforce — run it with --guardrails permissive, or pass --allow-unguarded-engine to run it without them';
  assert.equal(engineRefusalFor(cliText, 'ui'), 'engine codex: guardrail set "normal" has permission rules this engine cannot enforce — run it with the Permissive set, or tick Allow unguarded to run it without them');
  assert.equal(engineRefusalFor(cliText, 'chat'), 'engine codex: guardrail set "normal" has permission rules this engine cannot enforce — run it with the Permissive set, or resume it in the Worca UI with Allow unguarded to run it without them');
  assert.equal(engineRefusalFor(cliText, 'cli'), cliText);
});

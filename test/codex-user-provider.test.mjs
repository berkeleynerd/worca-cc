// test/codex-user-provider.test.mjs — the user's own Codex sign-in when it is a model provider in their
// config.toml (src/core/engines/codex-user-provider.mjs): what is read back from the file, the `-c` overrides
// a spawn gets under --ignore-user-config, and the secrets kept off argv. Every case injects `read` and `env`,
// or a temp CODEX_HOME: nothing here reads the developer's real ~/.codex.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseUserProvider, codexUserProviderSpawn, CODEX_USER_TOKEN_ENV } from '../src/core/engines/codex-user-provider.mjs';
import { runCodexProcess } from '../src/core/engines/codex.mjs';
import { fakeCodex } from './helpers/fake-codex.mjs';
import { useTempHome } from './helpers/temp-home.mjs';

useTempHome(after);

const POSIX = { skip: process.platform === 'win32' };
const dirs = [];
const tmp = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), 'codex-up-'))); dirs.push(d); return d; };
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** codexUserProviderSpawn over `text` as the config.toml of CODEX_HOME=/cx; `seen` collects the paths read. */
const spawnOf = (text, { env = {}, seen = [] } = {}) =>
  codexUserProviderSpawn({ env: { CODEX_HOME: '/cx', ...env }, read: (p) => { seen.push(p); return text; } });
/** The `-c` values of a spawn, in order. */
const overrides = (s) => s.args.filter((_, i) => i % 2 === 1);

const GATEWAY = `
approval_policy = "never"
sandbox_mode = "danger-full-access"
notify = ["/usr/local/bin/hook", "codex"]
model_provider = "gw"
model = "gpt-6-astra"

[model_providers.gw]
name = "Corp Gateway"
base_url = "https://gw.example/v1"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 4

[mcp_servers.tools]
url = "http://tools.example/mcp"
http_headers = { Authorization = "Bearer mcp-secret" }
`;

test('no provider: an empty file, one with no model_provider, or one naming a provider it does not define', () => {
  assert.equal(parseUserProvider(''), null);
  assert.equal(parseUserProvider(undefined), null);
  assert.equal(parseUserProvider('model = "gpt-6-astra"\n[model_providers.gw]\nbase_url = "https://gw.example/v1"\n'), null, 'a table nobody selects');
  assert.equal(parseUserProvider('model_provider = "gw"\nmodel = "gpt-6-astra"\n'), null, 'a provider with no table');
  assert.equal(parseUserProvider('model_provider = "gw"\n[model_providers.other]\nbase_url = "https://o.example/v1"\n'), null);
  assert.equal(parseUserProvider('[profiles.work]\nmodel_provider = "gw"\n[model_providers.gw]\nbase_url = "https://gw.example/v1"\n'), null, 'only the top-level key selects');
  assert.equal(parseUserProvider('model_provider = "not an id!"\n[model_providers."not an id!"]\nbase_url = "https://gw.example/v1"\n'), null, 'an id that is not a plain name');
  assert.equal(spawnOf('model = "gpt-6-astra"\n'), null);
});

test('the built-in provider `openai` is codex\'s own: nothing is carried, even with a table', () => {
  const text = 'model_provider = "openai"\n[model_providers.openai]\nbase_url = "https://api.openai.com/v1"\n';
  assert.equal(parseUserProvider(text), null);
  assert.equal(spawnOf(text), null);
});

test('a named provider: its string, bool and number keys become -c overrides; nothing else in the file is carried', () => {
  assert.deepEqual(parseUserProvider(GATEWAY), { id: 'gw', keys: [
    ['name', '"Corp Gateway"'], ['base_url', '"https://gw.example/v1"'], ['wire_api', '"responses"'], ['requires_openai_auth', 'false'], ['request_max_retries', '4'],
  ] });
  const seen = [];
  const s = spawnOf(GATEWAY, { seen });
  assert.deepEqual(seen, [join('/cx', 'config.toml')], 'read from CODEX_HOME');
  assert.deepEqual(s, {
    id: 'gw',
    args: [
      '-c', 'model_provider="gw"',
      '-c', 'model_providers.gw.name="Corp Gateway"',
      '-c', 'model_providers.gw.base_url="https://gw.example/v1"',
      '-c', 'model_providers.gw.wire_api="responses"',
      '-c', 'model_providers.gw.requires_openai_auth=false',
      '-c', 'model_providers.gw.request_max_retries=4',
    ],
    env: {},
    secrets: [],
  });
  const joined = s.args.join(' ');
  for (const other of ['approval_policy', 'sandbox_mode', 'notify', 'mcp_servers', 'mcp-secret', 'gpt-6-astra']) assert.equal(joined.includes(other), false, other);
});

test('the file is read from CODEX_HOME, or ~/.codex when it is unset or blank', () => {
  for (const env of [{}, { CODEX_HOME: '  ' }]) {
    const seen = [];
    codexUserProviderSpawn({ env, read: (p) => { seen.push(p); return GATEWAY; } });
    assert.deepEqual(seen, [join(homedir(), '.codex', 'config.toml')]);
  }
});

test('http_headers moves to env_http_headers: the names on argv, the values only in the env', () => {
  const s = spawnOf(`model_provider = "gw"
[model_providers.gw]
base_url = "https://gw.example/v1"
http_headers = { "X-Api-Key" = "hdr-secret-1", Authorization = 'Bearer hdr-secret-2' }
`);
  assert.deepEqual(overrides(s), [
    'model_provider="gw"',
    'model_providers.gw.base_url="https://gw.example/v1"',
    'model_providers.gw.env_http_headers={"X-Api-Key"="WORCA_CODEX_USER_HEADER_0","Authorization"="WORCA_CODEX_USER_HEADER_1"}',
  ]);
  assert.deepEqual(s.env, { WORCA_CODEX_USER_HEADER_0: 'hdr-secret-1', WORCA_CODEX_USER_HEADER_1: 'Bearer hdr-secret-2' });
  assert.deepEqual(s.secrets, ['hdr-secret-1', 'Bearer hdr-secret-2'], 'both values are redacted from the run\'s output');
  assert.equal(s.args.some((a) => a.includes('hdr-secret')), false, 'no header value on argv');
  assert.equal(s.args.some((a) => a.includes('.http_headers=')), false);
  const empty = spawnOf('model_provider = "gw"\n[model_providers.gw]\nbase_url = "https://gw.example/v1"\nhttp_headers = {}\n');
  assert.deepEqual(overrides(empty), ['model_provider="gw"', 'model_providers.gw.base_url="https://gw.example/v1"'], 'an empty table adds nothing');
  assert.deepEqual(empty.env, {});
});

test('experimental_bearer_token moves to env_key: the token only in the env', () => {
  const s = spawnOf(`model_provider = "sandboxd"
[model_providers.sandboxd]
name = "Sandbox Proxy"
base_url = "https://proxy.example/codex"
experimental_bearer_token = "tok-secret-123"
requires_openai_auth = false
`);
  assert.equal(CODEX_USER_TOKEN_ENV, 'WORCA_CODEX_USER_BEARER');
  assert.deepEqual(overrides(s), [
    'model_provider="sandboxd"',
    'model_providers.sandboxd.name="Sandbox Proxy"',
    'model_providers.sandboxd.base_url="https://proxy.example/codex"',
    'model_providers.sandboxd.env_key="WORCA_CODEX_USER_BEARER"',
    'model_providers.sandboxd.requires_openai_auth=false',
  ]);
  assert.deepEqual(s.env, { WORCA_CODEX_USER_BEARER: 'tok-secret-123' });
  assert.deepEqual(s.secrets, ['tok-secret-123']);
  assert.equal(s.args.some((a) => a.includes('tok-secret-123') || a.includes('experimental_bearer_token')), false, 'no token on argv');
});

test('comments, CRLF, spacing and quoted table names', () => {
  const text = [
    '# model_provider = "commented-out"',
    'model_provider = "my-gw"   # the corporate one',
    '',
    '[ model_providers . "my-gw" ]   # quoted, with spaces',
    '# base_url = "https://old.example/v1"',
    'base_url = "https://gw.example/v1#frag"  # a hash inside the string stays',
    "name = 'Gate # way'",
    'supports_websockets = true # yes',
    '',
    '[model_providers.other]',
    'base_url = "https://other.example/v1"',
  ].join('\r\n');
  assert.deepEqual(parseUserProvider(text), { id: 'my-gw', keys: [['base_url', '"https://gw.example/v1#frag"'], ['name', "'Gate # way'"], ['supports_websockets', 'true']] });
  assert.deepEqual(overrides(spawnOf(text)), [
    'model_provider="my-gw"',
    'model_providers.my-gw.base_url="https://gw.example/v1#frag"',
    "model_providers.my-gw.name='Gate # way'",
    'model_providers.my-gw.supports_websockets=true',
  ]);
  assert.equal(parseUserProvider("model_provider = 'lit'\n[model_providers.lit]\nbase_url = \"https://l.example/v1\"\n").id, 'lit', 'a literal-string id');
});

test('multi-line and malformed values are skipped; the rest of the table still travels', () => {
  const s = spawnOf(`model_provider = "gw"
[model_providers.gw]
base_url = "https://gw.example/v1"
name = """
Multi
line"""
query_params = {
  api-version = "2026-01-01",
}
stream_idle_timeout_ms = 30_000
wire_api = responses
broken = "unterminated
http_headers = { X-Team = 42 }
experimental_bearer_token = 12345
env_key = "GW_KEY"

[model_providers.gw.auth]
command = "print-token"

[[model_providers.gw.extra]]
k = "v"
`);
  assert.deepEqual(overrides(s), ['model_provider="gw"', 'model_providers.gw.base_url="https://gw.example/v1"', 'model_providers.gw.env_key="GW_KEY"']);
  assert.deepEqual(s.env, {}, 'a header table or token that is not a string sets nothing');
  assert.deepEqual(s.secrets, []);
});

test('WORCA_CODEX_USER_PROVIDER=0 turns it off without reading the file; any other value leaves it on', () => {
  const seen = [];
  assert.equal(spawnOf(GATEWAY, { env: { WORCA_CODEX_USER_PROVIDER: '0' }, seen }), null);
  assert.equal(spawnOf(GATEWAY, { env: { WORCA_CODEX_USER_PROVIDER: ' 0 ' }, seen }), null);
  assert.deepEqual(seen, [], 'the file is not read');
  assert.equal(spawnOf(GATEWAY, { env: { WORCA_CODEX_USER_PROVIDER: '1' } }).id, 'gw');
  assert.equal(spawnOf(GATEWAY, { env: { WORCA_CODEX_USER_PROVIDER: '' } }).id, 'gw');
});

test('an unreadable config.toml is no provider, never a throw', () => {
  assert.equal(codexUserProviderSpawn({ env: { CODEX_HOME: '/cx' }, read: () => { throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }); } }), null);
  assert.equal(codexUserProviderSpawn({ env: { CODEX_HOME: '/cx' }, read: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } }), null);
  assert.equal(codexUserProviderSpawn({ env: { CODEX_HOME: tmp() } }), null, 'the default reader on a home with no config.toml');
});

/** Run `fn` with the process env keys of `vars` set (undefined = unset), restored after. */
async function withEnv(vars, fn) {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

test('runCodexProcess: the spawn carries the user\'s provider, the token in its env and redacted from its output; the opt-out drops it', POSIX, async () => {
  const home = tmp();
  writeFileSync(join(home, 'config.toml'), 'model_provider = "gw"\n[model_providers.gw]\nbase_url = "https://gw.example/v1"\nexperimental_bearer_token = "tok-secret-123"\n');
  const dir = tmp();
  const fake = fakeCodex(dir, 'the token is tok-secret-123');
  const events = [];
  const out = await withEnv({ CODEX_HOME: home, WORCA_CODEX_USER_PROVIDER: undefined }, () =>
    runCodexProcess({ cwd: dir, bin: fake.bin, prompt: 'P', usageDir: dir, onEvent: (e) => events.push(e) }));
  const args = fake.args();
  assert.ok(args.includes('--ignore-user-config'), 'the rest of the user\'s config still stays out');
  for (const value of ['model_provider="gw"', 'model_providers.gw.base_url="https://gw.example/v1"', `model_providers.gw.env_key="${CODEX_USER_TOKEN_ENV}"`]) {
    assert.equal(args[args.indexOf(value) - 1], '-c', `${value} in ${args.join(' ')}`);
  }
  assert.equal(args.some((a) => a.includes('tok-secret-123')), false, 'the token never goes on argv');
  assert.equal(fake.env()[CODEX_USER_TOKEN_ENV], 'tok-secret-123');
  assert.equal(out.text.includes('tok-secret-123'), false, out.text);
  assert.equal(JSON.stringify(events).includes('tok-secret-123'), false, 'every event leaves redacted');

  await withEnv({ CODEX_HOME: home, WORCA_CODEX_USER_PROVIDER: '0' }, () => runCodexProcess({ cwd: dir, bin: fake.bin, prompt: 'P', usageDir: dir, onEvent: () => {} }));
  assert.equal(fake.args().some((a) => a.includes('model_provider')), false, 'opted out: codex runs on auth.json alone');
  assert.equal(CODEX_USER_TOKEN_ENV in fake.env(), false);
});

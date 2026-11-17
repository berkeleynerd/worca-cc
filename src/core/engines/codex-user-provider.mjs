// src/core/engines/codex-user-provider.mjs
// The user's own Codex sign-in, when it is a model provider in their config.toml.
//
// Every worca spawn passes --ignore-user-config, so that nothing else in the user's
// $CODEX_HOME/config.toml (sandbox mode, approval policy, MCP servers, notify hooks) reaches a run.
// That flag also drops `model_provider` and its `[model_providers.<id>]` table. For a user who
// signs in through such a provider (a corporate gateway, a sandbox proxy that holds the real
// credential), codex then calls OpenAI directly with whatever auth.json holds and fails with 401.
//
// This module reads exactly those keys back and returns them as `-c` overrides, which do apply
// under --ignore-user-config. Nothing else from the file is carried. Literal header values and a
// literal bearer token never go on argv: they travel in the codex process env, like the key and
// headers of a catalog endpoint (codex-endpoint.mjs).
//
// WORCA_CODEX_USER_PROVIDER=0 turns this off (codex then uses auth.json alone, as upstream does).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HEADER_ENV_PREFIX = 'WORCA_CODEX_USER_HEADER_';
export const CODEX_USER_TOKEN_ENV = 'WORCA_CODEX_USER_BEARER';
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const tomlStr = (s) => JSON.stringify(String(s));

const userHomeOf = (env) => (env.CODEX_HOME && String(env.CODEX_HOME).trim()) || join(homedir(), '.codex');

/** Strip a trailing `# comment` that is outside any string. */
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#') return line.slice(0, i);
  }
  return line;
}

/** A single-line TOML basic or literal string → its value, or null when `raw` is not one. */
function tomlStringValue(raw) {
  const s = raw.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) { try { return JSON.parse(s); } catch { return null; } }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'") && !s.slice(1, -1).includes("'")) return s.slice(1, -1);
  return null;
}

/** `{ "K" = "v", K2 = "v2" }` with string values → [[k, v], …], or null when it is anything else. */
function inlineStringTable(raw) {
  const s = raw.trim();
  if (!s.startsWith('{') || !s.endsWith('}')) return null;
  const body = s.slice(1, -1).trim();
  if (!body) return [];
  const out = [];
  const re = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(,|$)/y;
  let at = 0;
  while (at < body.length) {
    re.lastIndex = at;
    const m = re.exec(body);
    if (!m) return null;
    const key = m[1] !== undefined ? JSON.parse(`"${m[1]}"`) : m[2] !== undefined ? m[2] : m[3];
    const value = tomlStringValue(m[4]);
    if (value === null) return null;
    out.push([key, value]);
    at = re.lastIndex;
  }
  return out;
}

/**
 * Parse the two things this module needs from a codex config.toml: the top-level `model_provider`
 * and the scalar keys of `[model_providers.<that id>]`. Pure. Returns `{id, keys: [[key, rawTomlValue], …]}`
 * or null when the file names no provider (or names one it does not define, or the built-in `openai`).
 * Multi-line values and nested tables are not carried.
 */
export function parseUserProvider(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  let table = '';
  let id = null;
  const tables = new Map();
  for (const full of lines) {
    const line = stripComment(full).trim();
    if (!line) continue;
    const head = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
    if (head) { table = head[1].replace(/\s+/g, ''); continue; }
    if (line.startsWith('[[')) { table = '\u0000'; continue; }
    const kv = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    if (table === '' && kv[1] === 'model_provider') { id = tomlStringValue(kv[2]); continue; }
    const mp = /^model_providers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))$/.exec(table);
    if (mp) {
      const name = mp[1] ?? mp[2];
      if (!tables.has(name)) tables.set(name, []);
      tables.get(name).push([kv[1], kv[2].trim()]);
    }
  }
  if (!id || !ID_RE.test(id) || id === 'openai' || !tables.has(id)) return null;
  return { id, keys: tables.get(id) };
}

/**
 * What a codex spawn needs to sign in the way the user's own codex does, or null when their config
 * names no provider of its own: `{id, args, env, secrets}`.
 * @param {{env?: object, read?: (path: string) => string}} [o]
 */
export function codexUserProviderSpawn({ env = process.env, read = (p) => readFileSync(p, 'utf8') } = {}) {
  if (String(env.WORCA_CODEX_USER_PROVIDER ?? '').trim() === '0') return null;
  let text;
  try { text = read(join(userHomeOf(env), 'config.toml')); } catch { return null; }
  const parsed = parseUserProvider(text);
  if (!parsed) return null;
  const at = `model_providers.${parsed.id}`;
  const args = ['-c', `model_provider=${tomlStr(parsed.id)}`];
  const spawnEnv = {};
  for (const [key, raw] of parsed.keys) {
    if (key === 'http_headers') {
      // Literal header values stay off argv: each becomes an env var named by env_http_headers.
      const pairs = inlineStringTable(raw);
      if (!pairs) continue;
      pairs.forEach(([, v], i) => { spawnEnv[`${HEADER_ENV_PREFIX}${i}`] = v; });
      if (pairs.length) args.push('-c', `${at}.env_http_headers={${pairs.map(([k], i) => `${tomlStr(k)}=${tomlStr(`${HEADER_ENV_PREFIX}${i}`)}`).join(',')}}`);
      continue;
    }
    if (key === 'experimental_bearer_token') {
      const token = tomlStringValue(raw);
      if (token === null) continue;
      spawnEnv[CODEX_USER_TOKEN_ENV] = token;
      args.push('-c', `${at}.env_key=${tomlStr(CODEX_USER_TOKEN_ENV)}`);
      continue;
    }
    // A scalar or a single-line inline table, passed on as the TOML it already is.
    if (/^("(?:[^"\\]|\\.)*"|'[^']*'|true|false|[+-]?\d+(?:\.\d+)?|\{.*\})$/.test(raw)) args.push('-c', `${at}.${key}=${raw}`);
  }
  return { id: parsed.id, args, env: spawnEnv, secrets: Object.values(spawnEnv) };
}

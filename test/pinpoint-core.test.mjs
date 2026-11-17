// Pinpoint (#669): src/core/pinpoint.mjs — input validation, the prompts, the alternatives parser, and runPinpoint's
// no-tools spawn (an injected runner stands in for the Claude CLI).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validatePinpointInput, buildExplainPrompt, buildAlternativesPrompt, parseAlternatives, runPinpoint, PINPOINT_QUOTE_MAX,
  PINPOINT_CONTEXT_MAX, pinpointCwd, pinpointModel,
} from '../src/core/pinpoint.mjs';
import { CODEX_DEFAULT_MODEL } from '../src/core/engines/codex.mjs';
import { useTempHome } from './helpers/temp-home.mjs';

useTempHome(after);   // runPinpoint asks the catalog which harness owns its model: never the developer's own settings

const scratch = await mkdtemp(join(tmpdir(), 'pinpoint-'));
after(() => rm(scratch, { recursive: true, force: true }));

test('validatePinpointInput', () => {
  assert.equal(validatePinpointInput(null).ok, false);
  assert.match(validatePinpointInput({ action: 'summarize', quote: 'x' }).error, /action/);
  assert.match(validatePinpointInput({ action: 'explain', quote: '  ' }).error, /quote is required/);
  assert.match(validatePinpointInput({ action: 'explain', quote: 'x'.repeat(PINPOINT_QUOTE_MAX + 1) }).error, /at most/);
  assert.match(validatePinpointInput({ action: 'explain', quote: 'x', context: 3 }).error, /context/);
  const v = validatePinpointInput({ action: 'alternatives', quote: ' q ', context: 'c'.repeat(PINPOINT_CONTEXT_MAX + 5), surface: 'evil', source: ' plan.md\n' });
  assert.equal(v.ok, true);
  assert.deepEqual({ ...v.value, context: v.value.context.length }, { action: 'alternatives', quote: 'q', context: PINPOINT_CONTEXT_MAX, surface: 'chat', source: 'plan.md' });
});

test('the prompts carry the span, its context and its source; the span is fenced as data', () => {
  const input = { quote: 'fails open', context: 'If Redis is down, the middleware fails open.', surface: 'artifact', source: 'plan.md' };
  const e = buildExplainPrompt(input);
  assert.match(e, /run artifact .*\(plan\.md\)/);
  assert.match(e, /## Context\n<<<\nIf Redis is down/);
  assert.match(e, /## Highlighted span\n<<<\nfails open\n>>>/);
  const a = buildAlternativesPrompt(input);
  assert.match(a, /"alternatives"/);
  assert.doesNotMatch(buildExplainPrompt({ ...input, context: 'fails open' }), /## Context/, 'no context block that only repeats the span');
});

test('parseAlternatives reads bare, fenced and wrapped JSON, and drops junk', () => {
  const one = { title: 'Fail closed', detail: 'Answer 503.', tradeoffs: [{ tone: 'bad', text: 'Outage spreads' }, { tone: '?', text: 'x' }] };
  assert.deepEqual(parseAlternatives(JSON.stringify({ alternatives: [one] })), [{ title: 'Fail closed', detail: 'Answer 503.', tradeoffs: [{ tone: 'bad', text: 'Outage spreads' }, { tone: 'warn', text: 'x' }] }]);
  assert.equal(parseAlternatives('```json\n' + JSON.stringify({ alternatives: [one, one, one, one] }) + '\n```').length, 3);
  assert.equal(parseAlternatives('Sure! ' + JSON.stringify({ alternatives: [one] }) + ' Hope that helps.').length, 1);
  assert.deepEqual(parseAlternatives('no json here'), []);
  assert.deepEqual(parseAlternatives(JSON.stringify({ alternatives: [{ detail: 'untitled' }] })), []);
});

/** A fake runClaude: records its options, plays `events` through onEvent, resolves with `text`. */
function fakeRun({ events = [], text = '' } = {}) {
  const calls = [];
  const run = async (o) => {
    calls.push(o);
    for (const e of events) o.onEvent(e);
    return { text };
  };
  return { run, calls };
}
const delta = (t) => ({ raw: { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } } } });

test('runPinpoint explain: streams deltas, no tools, no MCP, scrubbed env', async () => {
  const { run, calls } = fakeRun({ events: [delta('It lets '), delta('requests through.')], text: 'It lets requests through.' });
  const got = [];
  const out = await runPinpoint({ action: 'explain', quote: 'fails open', context: '', surface: 'chat', source: '' }, { cwd: pinpointCwd(scratch), model: 'claude-haiku', run, onDelta: (t) => got.push(t) });
  assert.deepEqual(got, ['It lets ', 'requests through.']);
  assert.deepEqual(out, { text: 'It lets requests through.' });
  const o = calls[0];
  assert.deepEqual(o.tools, []);
  assert.deepEqual(o.allowedTools, []);
  assert.equal(o.strictMcpConfig, true);
  assert.equal(o.envScrub, true);
  assert.equal(o.disableSlashCommands, true);
  assert.equal(o.permissionMode, 'dontAsk');
  assert.equal(o.includePartialMessages, true);
  assert.equal(o.model, 'claude-haiku');
  assert.equal(o.cwd, join(scratch, 'tmp', 'pinpoint'));
});

test('runPinpoint on a Codex model: answered by codex in its read-only sandbox, no claude CLI routing env; the final text arrives in one piece', async () => {
  const { run, calls } = fakeRun({ text: 'It lets requests through.' });
  const got = [];
  const out = await runPinpoint({ action: 'explain', quote: 'fails open' }, { cwd: pinpointCwd(scratch), model: 'gpt-6-luna', run, onDelta: (t) => got.push(t) });
  assert.deepEqual(out, { text: 'It lets requests through.' });
  assert.deepEqual(got, ['It lets requests through.']);
  const o = calls[0];
  assert.deepEqual([o.engine, o.sandbox, o.model, o.spawnKind], ['codex', 'read-only', 'gpt-6-luna', 'aux']);
  assert.equal('modelEnv' in o, false);
  assert.deepEqual([o.tools, o.allowedTools, o.envScrub, o.envAllowlist], [[], [], true, []], 'the same no-tools, scrubbed call');
  // A Claude model: the claude CLI, as before.
  await runPinpoint({ action: 'explain', quote: 'q' }, { cwd: pinpointCwd(scratch), model: 'claude-haiku-4-5', run });
  assert.equal('engine' in calls[1], false);
  assert.equal('modelEnv' in calls[1], true);
});

test('pinpointModel: the Chat model of the engine for new chats when it runs helper jobs; Codex falls to its default; any other chat engine keeps Claude\'s', () => {
  const settings = (map) => (id) => ({ value: map[id] });
  assert.equal(pinpointModel(settings({ askEngine: 'codex', 'models.codex.ask': { model: 'gpt-6-astra' }, 'models.claude.ask': { model: 'claude-opus-5-5' } })), 'gpt-6-astra');
  assert.equal(pinpointModel(settings({ askEngine: 'codex', 'models.claude.ask': { model: 'claude-opus-5-5' } })), CODEX_DEFAULT_MODEL, 'no Codex Chat model: its default, never Claude\'s');
  assert.equal(pinpointModel(settings({ askEngine: 'claude', 'models.claude.ask': { model: 'claude-opus-5-5' }, 'models.codex.ask': { model: 'gpt-6-astra' } })), 'claude-opus-5-5');
  assert.equal(pinpointModel(settings({ askEngine: 'claude' })), undefined, 'no Claude Chat model: the CLI default');
  assert.equal(pinpointModel(settings({ 'models.claude.ask': { model: 'claude-opus-5-5' } })), 'claude-opus-5-5', 'no engine resolved reads as Claude');
  // Copilot, Cursor, Gemini CLI… run chats but no helper jobs: their Chat model is never handed to the claude CLI.
  for (const askEngine of ['copilot', 'cursor', 'gemini', 'goose', 'opencode', 'qwen']) {
    assert.equal(pinpointModel(settings({ askEngine, [`models.${askEngine}.ask`]: { model: 'copilot/gpt-5.4' }, 'models.claude.ask': { model: 'claude-opus-5-5' } })), 'claude-opus-5-5', askEngine);
  }
  assert.equal(pinpointModel(() => { throw new Error('settings unreadable'); }), undefined);
  // The real settings of a fresh install: Chat starts on Codex, so Pinpoint answers on Codex's default model.
  assert.equal(pinpointModel(), CODEX_DEFAULT_MODEL);
});

test('runPinpoint explain without partial messages still answers once; an empty answer throws', async () => {
  const got = [];
  const { run } = fakeRun({ text: 'Whole answer.' });
  assert.deepEqual(await runPinpoint({ action: 'explain', quote: 'q' }, { cwd: pinpointCwd(scratch), run, onDelta: (t) => got.push(t) }), { text: 'Whole answer.' });
  assert.deepEqual(got, ['Whole answer.']);
  await assert.rejects(runPinpoint({ action: 'explain', quote: 'q' }, { cwd: pinpointCwd(scratch), run: fakeRun({ text: ' ' }).run }), /no answer/);
});

test('runPinpoint alternatives: parsed cards, no streaming; none parsed throws', async () => {
  const { run, calls } = fakeRun({ text: JSON.stringify({ alternatives: [{ title: 'Drop it', detail: 'Leave it out.', tradeoffs: [] }] }) });
  const out = await runPinpoint({ action: 'alternatives', quote: 'q' }, { cwd: pinpointCwd(scratch), run });
  assert.deepEqual(out, { alternatives: [{ title: 'Drop it', detail: 'Leave it out.', tradeoffs: [] }] });
  assert.equal(calls[0].includePartialMessages, false);
  await assert.rejects(runPinpoint({ action: 'alternatives', quote: 'q' }, { cwd: pinpointCwd(scratch), run: fakeRun({ text: 'nope' }).run }), /no alternatives/);
});

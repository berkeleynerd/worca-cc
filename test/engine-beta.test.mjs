// test/engine-beta.test.mjs — an engine still in beta (src/shared/engine-switch.mjs BETA_ENGINES) is marked
// wherever an engine is picked: "(beta)" where only text fits, a Beta badge beside its name elsewhere.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { useDomRelease } from './helpers/jsdom-release.mjs';
import { BETA_ENGINES, isBetaEngine, engineChoiceLabel, ENGINE_NAMES } from '../src/shared/engine-switch.mjs';
import { renderEngineSection, renderAskEngineSection } from '../ui/public/engine-settings-view.mjs';

const trackDom = useDomRelease(afterEach);
const CATALOG = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', engine: 'claude', efforts: ['medium', 'high', 'xhigh', 'max'] },
  { id: 'gpt-5.5', label: 'GPT-5.5', engine: 'codex', efforts: ['minimal', 'low', 'medium', 'high'] },
];

test('every engine but Claude and Codex is in beta', () => {
  assert.deepEqual(BETA_ENGINES, ['copilot', 'cursor', 'gemini', 'goose', 'opencode', 'qwen']);
  assert.equal(engineChoiceLabel('opencode'), 'OpenCode (beta)');
  assert.equal(engineChoiceLabel('gemini'), 'Gemini CLI (beta)');
  assert.equal(engineChoiceLabel('qwen'), 'Qwen Code (beta)');
  for (const e of BETA_ENGINES) assert.ok(ENGINE_NAMES.includes(e), `${e} is a known engine`);
  assert.equal(engineChoiceLabel('cursor'), 'Cursor (beta)');
  assert.equal(isBetaEngine('codex'), false);
  assert.equal(isBetaEngine('copilot'), true);
  assert.equal(isBetaEngine('claude'), false);
  assert.equal(isBetaEngine(null), false);
  assert.equal(engineChoiceLabel('codex'), 'Codex');
  assert.equal(engineChoiceLabel('copilot'), 'Copilot (beta)');
  assert.equal(engineChoiceLabel('claude'), 'Claude');
});

test('Settings does not mark Codex as beta: the engine options and the Codex card heading; Copilot keeps its mark', () => {
  const dom = trackDom(new JSDOM('<div id="h"></div><div id="a"></div>'));
  const doc = dom.window.document;
  renderEngineSection(doc.getElementById('h'), { level: 'user', catalog: CATALOG, roles: [], fields: {} });
  const optionText = (root, id) => root.querySelector(`[data-setting="${id}"] select option[value="codex"]`).textContent;
  const optionOf = (root, id, engine) => root.querySelector(`[data-setting="${id}"] select option[value="${engine}"]`)?.textContent;
  assert.equal(optionText(doc.getElementById('h'), 'run.engine'), 'Codex');
  assert.equal(optionOf(doc.getElementById('h'), 'run.engine', 'copilot'), 'Copilot (beta)');
  const badge = (engine) => doc.querySelector(`.engine-card[data-engine="${engine}"] h3 .beta-badge`);
  assert.equal(badge('codex'), null);
  assert.equal(badge('claude'), null);
  // Codex is the default engine for new chats: it is the select's empty choice, named once, so it has no option of its own.
  renderAskEngineSection(doc.getElementById('a'), { catalog: CATALOG });
  const ask = doc.getElementById('a').querySelector('[data-setting="askEngine"] select');
  assert.equal(ask.options[0].textContent, 'Codex (default)');
  assert.equal(ask.querySelector('option[value="codex"]'), null);
  assert.equal(ask.querySelector('option[value="claude"]').textContent, 'Claude');
});

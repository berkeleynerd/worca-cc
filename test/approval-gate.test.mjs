// test/approval-gate.test.mjs
// The plain approval gate (fork): what counts as its answer, that a workflow may declare it, and that the
// run-control mailbox carries `approve`. The hold itself is tested in graph-scheduler-approve.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalAnswer, approvalWording, approvalSummary, approvalDocuments, APPROVAL_SUMMARY_MAX, APPROVAL_CHOICES, APPROVAL_ASK_KIND } from '../src/core/orchestrator.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PIPELINE_COMMAND_ACTIONS } from '../src/core/pipeline-commands.mjs';
import { validateGraph } from '../src/shared/graph/validate.mjs';
import { registryPortsFn } from '../src/core/graph/registry-ports.mjs';

test('approvalAnswer: a decision, or the card\'s one answer naming a choice exactly; nothing else', () => {
  assert.equal(APPROVAL_ASK_KIND, 'approval');
  assert.deepEqual(approvalAnswer({ decision: 'approve' }), { decision: 'approve' });
  assert.deepEqual(approvalAnswer({ decision: 'stop' }), { decision: 'stop' });
  assert.deepEqual(approvalAnswer({ answers: [{ id: 'approval', choice: APPROVAL_CHOICES.approve }] }), { decision: 'approve' });
  assert.deepEqual(approvalAnswer({ answers: [{ id: 'approval', choice: ` ${APPROVAL_CHOICES.stop} ` }] }), { decision: 'stop' });
  for (const bad of [null, undefined, 'approve', {}, { decision: 'continue' }, { decision: 'revise' }, { answers: [] },
    { answers: [{ id: 'approval', choice: 'looks fine to me' }] }, { answers: [{ id: 'approval', choice: 'approve' }] },
    { answers: [{ id: 'a', choice: 'Approve' }, { id: 'b', choice: 'Approve' }] }]) {
    assert.equal(approvalAnswer(bad), null, JSON.stringify(bad));
  }
});

test('the run-control mailbox takes approve beside stop and pause', () => {
  assert.deepEqual(PIPELINE_COMMAND_ACTIONS, ['stop', 'pause', 'approve']);
});

test('validation: approve.kind is plan or approval, and names an md output of the agent', () => {
  const registry = { writer: { key: 'writer', metaVersion: 2, runnerType: 'producer', inputs: [{ id: 'task', type: 'md' }], outputs: [{ id: 'doc', type: 'md', when: 'always' }] } };
  const graph = (approve) => ({ version: 2, name: 'G', nodes: [
    { id: 'n_task', kind: 'task', x: 0, y: 0, config: {} },
    { id: 'n_w', kind: 'agent', key: 'writer', x: 1, y: 0, config: { approve } },
    { id: 'n_end', kind: 'end', x: 2, y: 0, config: {} }],
  wires: [{ id: 'w1', from: { node: 'n_task', port: 'task' }, to: { node: 'n_w', port: 'task' } },
    { id: 'w2', from: { node: 'n_w', port: 'doc' }, to: { node: 'n_end', port: 'result' } }] });
  const v23 = (approve) => validateGraph(graph(approve), registryPortsFn(registry)).errors.filter((i) => i.code === 'V23').map((i) => i.message);
  assert.deepEqual(v23({ kind: 'approval', port: 'doc' }), []);
  assert.deepEqual(v23({ kind: 'plan', port: 'doc' }), []);
  assert.match(v23({ kind: 'gate', port: 'doc' })[0], /must be \{ kind: 'plan' \| 'approval'/);
  assert.match(v23({ kind: 'approval', port: 'nope' })[0], /is not an md output/);
});

test('a gate may word its own question and buttons; the answer must then name those buttons', () => {
  const w = approvalWording({ question: 'Post it?', approveLabel: 'Post this report', stopLabel: 'Do not post' }, 'Report', '/x/r.md');
  assert.equal(w.question, 'Post it?');
  assert.deepEqual(w.choices, { approve: 'Post this report', stop: 'Do not post' });
  assert.deepEqual(approvalAnswer({ answers: [{ choice: 'Post this report' }] }, w.choices), { decision: 'approve' });
  assert.deepEqual(approvalAnswer({ answers: [{ choice: 'Do not post' }] }, w.choices), { decision: 'stop' });
  assert.equal(approvalAnswer({ answers: [{ choice: APPROVAL_CHOICES.approve }] }, w.choices), null);
  assert.deepEqual(approvalAnswer({ decision: 'approve' }, w.choices), { decision: 'approve' });
  const d = approvalWording(null, 'Report', '/x/r.md');
  assert.deepEqual(d.choices, { ...APPROVAL_CHOICES });
  assert.match(d.question, /^Report is waiting for your approval.*Read \/x\/r\.md first\.$/);
  assert.equal(approvalWording({ approveLabel: 'Same', stopLabel: 'Same' }, 'R', null).choices.stop, APPROVAL_CHOICES.stop);
});

test('a gate summary is the text of the summary port\'s file beside the held file, capped; else empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'worca-gate-'));
  try {
    await writeFile(join(dir, 'report.md'), 'the report');
    await writeFile(join(dir, 'brief.md'), '  Recommend: post.\n');
    await writeFile(join(dir, 'long.md'), 'x'.repeat(APPROVAL_SUMMARY_MAX + 50));
    const outs = [{ id: 'report', filename: 'report.md' }, { id: 'brief', filename: 'brief.md' }, { id: 'long', filename: 'long.md' },
      { id: 'gone', filename: 'gone.md' }, { id: 'tpl', filename: 'x-{cycle}.md' }, { id: 'up', filename: '../brief.md' }];
    const held = join(dir, 'report.md');
    assert.equal(await approvalSummary({ summaryPort: 'brief' }, outs, held, 'report'), 'Recommend: post.');
    assert.equal(await approvalSummary({ summaryPort: 'report' }, outs, held, 'report'), 'the report');
    const long = await approvalSummary({ summaryPort: 'long' }, outs, held, 'report');
    assert.ok(long.length < APPROVAL_SUMMARY_MAX + 40 && long.endsWith('[cut: the file is longer]'));
    for (const port of ['gone', 'tpl', 'up', 'nope']) assert.equal(await approvalSummary({ summaryPort: port }, outs, held, 'report'), '', port);
    assert.equal(await approvalSummary({}, outs, held, 'report'), '');
    assert.equal(await approvalSummary({ summaryPort: 'brief' }, outs, null, 'report'), '');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('validation: the gate wording fields are short strings, the summary port is an md output, labels differ', () => {
  const registry = { writer: { key: 'writer', metaVersion: 2, runnerType: 'producer', inputs: [{ id: 'task', type: 'md' }],
    outputs: [{ id: 'doc', type: 'md', when: 'always' }, { id: 'brief', type: 'md', when: 'always' }] } };
  const graph = (approve) => ({ version: 2, name: 'G', nodes: [
    { id: 'n_task', kind: 'task', x: 0, y: 0, config: {} },
    { id: 'n_w', kind: 'agent', key: 'writer', x: 1, y: 0, config: { approve } },
    { id: 'n_end', kind: 'end', x: 2, y: 0, config: {} }],
  wires: [{ id: 'w1', from: { node: 'n_task', port: 'task' }, to: { node: 'n_w', port: 'task' } },
    { id: 'w2', from: { node: 'n_w', port: 'doc' }, to: { node: 'n_end', port: 'result' } }] });
  const v23 = (approve) => validateGraph(graph(approve), registryPortsFn(registry)).errors.filter((i) => i.code === 'V23').map((i) => i.message);
  const base = { kind: 'approval', port: 'doc' };
  assert.deepEqual(v23({ ...base, question: 'Post it?', approveLabel: 'Post', stopLabel: 'Do not post', summaryPort: 'brief' }), []);
  assert.match(v23({ ...base, approveLabel: '' })[0], /approveLabel must be a non-empty string/);
  assert.match(v23({ ...base, question: 7 })[0], /question must be a non-empty string/);
  assert.match(v23({ ...base, approveLabel: 'Go', stopLabel: 'Go' })[0], /must differ/);
  assert.match(v23({ ...base, summaryPort: 'nope' })[0], /summaryPort 'nope' is not an md output/);
});

test('a gate links its full documents: the held file first, then the named ports, each once, plain names only', () => {
  const outs = [{ id: 'report', filename: 'report.md' }, { id: 'issues', filename: 'issues.json' }, { id: 'tpl', filename: 'x-{cycle}.md' }];
  assert.deepEqual(approvalDocuments({}, outs, '/run/report.md', 'report'), [{ port: 'report', relPath: 'report.md' }]);
  assert.deepEqual(approvalDocuments({ documentPorts: ['issues', 'report', 'tpl', 'nope'] }, outs, '/run/report.md', 'report'),
    [{ port: 'report', relPath: 'report.md' }, { port: 'issues', relPath: 'issues.json' }]);
  assert.deepEqual(approvalDocuments({ documentPorts: ['issues'] }, outs, null, 'report'), [{ port: 'issues', relPath: 'issues.json' }]);
});

// test/approval-gate.test.mjs
// The plain approval gate (fork): what counts as its answer, that a workflow may declare it, and that the
// run-control mailbox carries `approve`. The hold itself is tested in graph-scheduler-approve.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalAnswer, APPROVAL_CHOICES, APPROVAL_ASK_KIND } from '../src/core/orchestrator.mjs';
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

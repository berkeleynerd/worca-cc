# Approval gate

Any workflow can make a run wait for a person before one step's result is handed on. Put this in the
agent node's config (workflow JSON):

    "config": { "approve": { "kind": "approval", "port": "<an md output of the node>" } }

When the node has written that output, the run holds it and asks one question with two choices:
**Approve** releases the file to the next node; **Stop the run** ends the run. Nothing after the gate
starts before the answer.

- **Where to answer.** In the Worca app, on the run (it is listed under *Needs you*). From a terminal,
  `worca approve <id>` approves a live run and `worca stop <id>` refuses it. A paused run is answered by
  resuming it in a terminal (`worca resume <id>`).
- **Never automatic.** `--yes` does not answer it (a `--yes` run started in a terminal pauses at the
  gate), and Away mode never decides it.
- **Only two answers.** Any other reply is refused and the question stays open.
- **Survives a pause.** The hold is kept in the resume point and asked again on resume.

`kind: "plan"` is the older stop of a *Shape it first* run (approve, ask for changes, stop); it stays
limited to shaped runs.

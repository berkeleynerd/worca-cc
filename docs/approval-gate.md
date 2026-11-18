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

## Wording, summary and script nodes

All optional, beside `kind` and `port`:

| Field | Effect |
| --- | --- |
| `question` | The card's question, in place of "<step> is waiting for your approval…". |
| `approveLabel`, `stopLabel` | The two buttons, in place of "Approve" and "Stop the run". They must differ. An answer must name the gate's own label; `worca approve` and `{decision}` work as before. |
| `summaryPort` | An md output of the same node. Its text is shown on the card above the question (plain text, as written, up to 8,000 characters), and printed before the terminal prompt. It may be the held port itself. Leading lines of the form `NAME=value` (an upper-case name, no spaces in the value) are treated as routing headers for the next step and left off the card; the full document still shows them. |
| `documentPorts` | Up to six further file outputs of the same node. The card shows a button for the held file and for each of these; a click opens the full document in the artifact viewer, so nothing a person approves has to be read outside the page. |

A script node may carry the gate too. With a verdict and an output marked `when: blocking`, a script can
stop for a person only when it fails: wire the clean and the blocking output into an `or` node, put the
gate on the blocking one, and the run goes on untouched when the script is clean.

A finished run that changed no file offers neither Create PR nor Try it: there is nothing to ship or check out.

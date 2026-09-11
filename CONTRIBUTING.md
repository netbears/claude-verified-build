# Contributing

The pair is small on purpose: one skill file, one engine file. Most changes are a prompt
edit, a knob, or a row in the token profile. This is how to make one without breaking the
copies that run it.

## The shape of a change

1. **Edit in a clone of this repo**, never in a profile's copy. Profiles are installs.
2. **Keep the two files in step.** A knob that exists in the engine but not in
   `SKILL.md`'s argument table is a knob nobody uses; a result field the skill tells the
   orchestrator to read must exist in the engine's return value. Check both before you
   commit.
3. **Run `./check.sh`.** It wraps the engine body in a function before `node --check`,
   because the script's top-level `return` is a Workflow-runtime feature that bare
   `node --check` rejects, then runs the tests. Keep `export const meta = {…}` at the
   top level and a pure literal: no variables, calls, spreads or template strings inside it.
   **Write the test first.** `test/helpers.test.js` pulls every pure helper out of the
   engine by name (keep each one a top-level `function name(...) {}`), and
   `test/engine.test.js` runs the whole script against a stubbed runtime with canned
   agent answers keyed by label. A knob, a return field or a failure path that is not
   asserted there is one the next edit can break silently — the ordering bug that put a
   bridging slice ahead of the task it consumed from was a five-line test away.
4. **Commit in the convention the engine asks of its own agents**: a subject that says
   what the thing now does, present tense, no trailing period; the body says why, with
   the measurement when there is one.
5. **Install everywhere** with `./install.sh <every profile> <host>:<dir>` and read the
   checksums it prints. Restart a resident session on a server.
6. **Record it in `CHANGELOG.md`** under the next version, and tag the release.

## Rules the engine relies on

- **No clock, no randomness.** `Date.now()`, `new Date()` and `Math.random()` throw inside
  a Workflow script because they would break resume. Today's date comes from Recon
  (`date -I`); anything random is varied by index.
- **Cache-safe pauses.** A resume replays every `agent()` call whose prompt and options are
  unchanged. So a prompt that runs *before* a pause must never contain the thing the pause
  collects (an owner's answer, an approval), or the resume re-runs it at full cost. Put
  such inputs only in prompts that run after the pause.
- **One agent per slice, one verifier per slice.** Never merge slices into one context and
  never widen what a single verifier reads. Serialise through declared file overlap.
- **No lane throws.** `callAgent` turns every failure into `null` plus a `lane_errors`
  entry; every caller handles `null`. A raw `agent()` call belongs only in the probe,
  where a fallback would hide exactly what is being checked.
- **Finding ids are namespaced by round** (`r0:F1`). Anything that compares findings
  across rounds compares those ids, and a re-review's `re_raises` points at one.
- **Findings need evidence.** Every reviewer schema requires a concrete failure scenario or
  a command-and-output; keep it that way. A finding without evidence is noise the patch
  round pays for.
- **The doctrine blocks are quotations.** They come from the superpowers skills under MIT.
  Adapt them only where a stage has no human to ask; do not rewrite them into something
  else and keep the attribution in `LICENSE.md`.
- **2-space indent** in the engine. Imports from other machines have arrived re-indented;
  fix that before merging, never copy over.

## Changing the numbers

- **Defaults** (`maxRounds`, `patchSeverity`, `wave`, `maxSlices`) were set from measured
  runs. Change them with a measurement, and write the measurement into `SKILL.md`'s
  "Tuned from six runs" section so the next person knows why.
- **The token profile** (`PROFILE` in the engine) feeds the cost gate. Rows marked
  `measured:false` are assumptions; replace them with figures reconstructed from real
  transcripts (`agent-*.jsonl` under the workflow's transcript directory carry per-turn
  `usage`) and flip the flag.
- **Prices** (`PRICES`) are Anthropic first-party list prices with a cache date in the
  comment. Update the date when you update the numbers.

## What not to do

- Do not add a plugin, package or network dependency. An install is two file copies.
- Do not make the engine repo-specific. Recon exists so that nothing else has to know what
  the repo is.
- Do not answer an owner question or approve a cost gate inside the engine or the skill's
  instructions. Those pauses exist precisely so a person decides.

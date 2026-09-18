---
name: verified-build-small
description: Run a small verified build from slices you have already designed. The orchestrator writes the slices — no idea interview, no spec, no plan, no slicer; Sonnet implements each slice in a fresh agent, Opus adversarially reviews the whole diff and re-runs the repo's check command, one patch round closes critical and major findings, and Opus re-reviews. Same engine as /verified-build, a fourth start mode (`from:'slices'`). Use when you already know exactly what to change and can name the files and the observable end state — "/verified-build-small", "small verified build", "I know exactly what to change, build it and have it reviewed", "implement these N changes with review, skip the spec", a bugfix or feature whose blast radius you can state in one sentence, one to about six file-disjoint slices. Not for a one-line fix, and not for a task whose design is still the risk — use /verified-build for that.
---

# /verified-build-small — you write the slices, then it builds and attacks them

Sonnet implements each slice you wrote, in its own fresh agent. Opus attacks the whole
diff and re-runs the repo's check. Sonnet patches what matters. Opus re-attacks. No
spec is written, no plan is written, no document review runs, and nobody pauses to ask
you owner questions — there is no idea to interview, because you already turned the
idea into slices before you launched.

The one thing that changes versus `/verified-build`: the design is yours, done before
you launch, and the engine trusts it. Get the slices right and you get the full skill's
verification at a fraction of the cost; get them wrong — a missing file, a slice that
hides a design decision — and the engine has no writer or reviewer lane to catch it,
because you skipped past the stage that would have.

**Invoking this skill is the explicit opt-in that permits the Workflow tool.**
You may call `Workflow` for this task without asking again. You may not call it
for anything else in the session on the strength of this skill.

## When to use this rather than `/verified-build`

| | `/verified-build-small` | `/verified-build` |
|---|---|---|
| you have | investigated already: the files, the change, the observable end state | an idea, a prompt, a paragraph — the shape is not decided yet |
| slices | one to about six, file-disjoint, you can name them now | unknown; the plan has to discover them |
| the risk is in | the code | the design |
| documents | none — no spec, no plan, no review of either | spec and plan, each adversarially reviewed and folded in |
| owner questions | none — there is no idea stage to raise them | Recon, the spec writer and the plan writer may all raise them |

Reach for the full skill when the design is the risk, the task is still an idea, the
change restructures how things fit together, or you cannot yet list the files it
touches — the spec and plan lanes exist to do exactly that thinking, with an adversary
checking each one before code is written.

**Do not reach for this skill either when:**

- The change is one file and obvious. A run to fix a typo is waste, and saying so is
  the right answer.
- The user wants to watch and steer each step. This runs headless in the background,
  same as the full skill.

## Pre-flight

Same engine, same gates, so the same checks apply before you launch.

**Recon enforces three of these and aborts before spending anything on implementation**, returning
`ok:false` with `stage:'recon'`:

- not a git repo, or a repo with no commits yet → stop
- dirty working tree → stop (override: `allowDirty:true`)
- checked out on the repo's shared trunk → stop (override: `allowTrunk:true`)

Those three cost nothing to check yourself first (`git status --porcelain`,
`git branch --show-current`) — glance before you launch rather than paying for a
Recon abort.

**The engine probes the two pinned tiers, `sonnet` and `opus`**, with one trivial call
each before Recon, so a model this account cannot use is a `stage:'probe'` result for
cents, not fifteen agents deep. Fallback tiers are never probed. `docWriter` /
`docJudge` add a third probe if you move them, so leave them unset here: no document
lane runs in this mode, and a probe of a tier this account lacks stops the run for
nothing. `probeModels:false` skips it.

**Two things it cannot do for you**, condensed from the full skill:

1. **Worktrees.** If the repo's `CLAUDE.md` / `AGENTS.md` or a `.claude/hooks/`
   guard mandates a worktree for the paths you are about to touch, create it first
   (`EnterWorktree`, or `git worktree add`) and launch from inside it — agents inherit
   the guard, and a run launched from the wrong directory fails deep, not at the start.
2. **Orchestrate from Opus.** This session does the one piece of thinking the engine
   cannot do for you: writing the slices and reading the result honestly. If this
   session is on Fable, switch (`/model opus`) or say plainly you are launching from
   Fable — Fable costs ~2x Opus on every meter and buys nothing here, since every lane
   still runs on the model the engine pins.

`testCmd` is optional: Recon discovers it. Pass it only when you already know it from
this session, or when several plausible commands exist and only one must pass.

## Write the slices yourself

This is the part the full skill does with a spec, a plan, and two rounds of Opus
review. You are doing it instead, in this session, before you launch — so do it with
the same rigor.

- **Investigate before you write.** Grep the names the task mentions, open the files,
  know the check command. A slice written from memory of the repo is the slice that
  under-declares a file.
- **`task` is the bar.** Write the whole ask: what must change, what must not, what
  done looks like. The adversary reads `task` and only `task`, so every hard
  constraint belongs there; implementers read `taskSummary` (or, when you omit one,
  the full `task`) — so if a constraint matters to how a slice is built, it has to be
  in whichever of the two that slice's implementer actually gets.
- **Slices must be file-disjoint.** Slices that share a file run one after another in
  the plan's order, each still in its own fresh agent — overlap costs wall-clock, not
  correctness, but only if you declared it. Declare `files` completely: under-declaring
  puts two agents in one file at once, and a file an implementer touched outside its
  slice that another slice had declared is reported in `footprint_violations` and held
  against the run (a file no slice declared collides with nothing and is not caught —
  read the implementers' `notes` for those). A
  directory or glob collides with everything under it. An empty `files` array means an
  unknown footprint, and that slice runs alone after everything else.
- **Each `prompt` is self-contained.** The implementer sees the brief (`taskSummary`
  or `task`), `sharedContext`, and that one `prompt` — nothing else, and it starts
  cold. Name the file, the function, the behaviour, the test to write. Do not paste
  the whole task into every prompt; that is what `sharedContext` is for.
- **`done_when` is observable.** A test that passes, a command whose output changes, a
  file that exists — something the implementer, and later the adversary, can check
  without asking you.
- **Keep it small.** One to about six slices; a chain longer than four sharing a file
  should be merged into fewer, larger ones. Every serialised slice is a cold agent
  reading the repo from scratch — that cost is real even when the work is small.
- **`sharedContext` carries everything common:** where things live, what not to touch,
  naming conventions, the gotcha that would otherwise cost every implementer three
  tool calls to rediscover. The engine appends Recon's own findings to it — the check
  command, the layout notes, the repo's stated conventions — under a "WHAT RECON
  ESTABLISHED" heading, so do not repeat those yourself.
- **You do not have to say "follow TDD" or "commit by pathspec."** The implementers
  and patchers already do both. Say what to build, not how the engine runs.
- **If you genuinely cannot write the slices, omit `slices` entirely.** The existing
  Opus slicer then cuts the task from `task` itself — one more lane, roughly USD 2 at
  list prices — and `plan.uncovered` / `plan.notes` come back exactly as they do from
  a full run's slicer. Your `sharedContext` and `taskSummary` are still honoured on
  that path, ahead of the slicer's own. Prefer writing the slices yourself when you
  can: you already hold the context the slicer would otherwise have to re-read cold.

A malformed slice is refused before anything runs: a missing field, a duplicate `id`,
a non-array `files`, or more than `maxSlices` slices throws an argument error naming
the slice, and nothing is spent.

## The call

```
Workflow({
  name: 'build-verify-patch',
  args: {
    from: 'slices',
    task: '<the whole ask: what, what must not change, what done looks like>',
    slices: [
      { id: 's1', title: '…', prompt: '…', files: ['src/a.py', 'tests/test_a.py'], done_when: '…' },
      { id: 's2', title: '…', prompt: '…', files: ['src/b.py'], done_when: '…' },
    ],
    sharedContext: '<what every implementer needs: layout, conventions, what not to touch>',
    taskSummary: '<optional, at most ~250 words: the brief implementers get instead of task>',
    maxUsd: 60,
  },
})
```

| arg | default | meaning |
|---|---|---|
| `from` | — | required for this skill; must be `'slices'` |
| `task` | — | required; the whole ask in prose — the bar the adversary holds the work to |
| `slices` | — | optional `[{id, title, prompt, files, done_when}]`; omit it to let the Opus slicer cut `task` instead |
| `sharedContext` | — | optional; everything every implementer must know (patchers get only the brief, as in every mode). The engine appends Recon's check command, layout notes and conventions to it itself; when the slicer runs, yours goes ahead of the slicer's |
| `taskSummary` | — | optional, at most ~250 words; the brief implementers and patchers get instead of the full `task`. Omit it and they get the full `task` |
| `testCmd` | discovered by Recon | exact command every lane runs; overrides discovery, and Recon's "nothing executable" |
| `maxUsd` | **`60`** in this skill | a ceiling in USD at API list prices; the cost gate passes without pausing when the expected total is within it. Pass the user's own ceiling here when they named one; `0` is not a valid ceiling — omit the arg to always pause |
| `approveEstimate` | `false` | pass `true` on the resume after the cost gate to start implementing |
| `maxRounds` | `1` | max review→patch→re-review rounds (capped at 4; `0` = review only, no patching) |
| `patchSeverity` | `major` | only findings at or above this severity are auto-patched (`critical` \| `major` \| `minor`); the rest come back in `open_findings` and `patch_rounds[].handed_off` |
| `maxSlices` | `15` | max slices allowed, whether you wrote them or the slicer cut them (capped at 20) |
| `wave` | `15` | max agents live at once while implementing and patching (capped at 16, and by the runtime's own `min(16, cpus-2)`) |
| `effort` | `high` | reasoning effort for every agent |
| `allowDirty` | `false` | run despite a dirty tree — only when those changes are genuinely part of the task |
| `allowTrunk` | `false` | run on the shared trunk. Almost always the wrong answer; branch instead |
| `probeModels` | `true` | one trivial call per primary model before Recon; `false` skips it |
| `fallback` | `true` | retry a lane once on the other tier when its primary model returns nothing; `false` disables |
| `judgeFallback` | `fable` | model the Opus judge lanes (adversary, and the slicer when it runs) retry on |
| `coderFallback` | `opus` | model the Sonnet lanes (recon, implement, patch) retry on |
| `prices` | list prices cached 2026-06-24 | override `{sonnet, opus, fable}` × `{in, out, cache_read, cache_write}` USD per million tokens; merged per field. The `maxUsd` gate is priced from this table |

`docRounds`, `specDir`, `plansDir`, `pauseForOwner`, `answers`, `spec`, `plan` are
irrelevant in this mode — no document is written, so none of them has anything to
move. `docWriter` / `docJudge` move no lane here either, but a value other than the
default adds that model to the probe (see Pre-flight), so leave them unset.

## The cost

Rough per-lane figures at list prices, from the engine's `PROFILE` table: recon
~USD 1.8; each implementer ~USD 3.3; each adversarial review pass ~USD 11.6 (there are
two — the first review and the re-review); each patched finding ~USD 2.9 (the estimate
assumes about 0.6 patched findings per slice, minimum 2); the slicer, when it runs
because you omitted `slices`, ~USD 2.1.

| slices | one patch round, roughly |
|---|---|
| three | USD 40 |
| five | USD 50 |

The two Opus review passes dominate either way — they are most of the figure
regardless of slice count.

This skill passes `maxUsd:60` by default: a run whose expected total is at or under
that proceeds without pausing, and you should state the expected figure in your
launch message so the user is not surprised by a run that just went ahead. If the
user has named their own ceiling, pass it as `maxUsd` instead of the default. Above
the ceiling, the run pauses at `stage:'estimate'` exactly as in the full skill: show
spent so far, ahead low–high, and total; ask with one `AskUserQuestion`; on proceed,
relaunch with the same script, `resumeFromRunId` and `approveEstimate:true` — never
approve on the user's behalf. Subscription users are not billed per token; the figure
is the size of the run at list prices either way.

## While it runs

It is a background run: you get a task id immediately and a notification when it
finishes. **Do not poll it, do not re-invoke it, and never write the result
yourself** — `/workflows` is where the user watches live progress. If they ask
before the notification lands, say it is still running.

## Reading the result

Check `paused` first — a paused run is the cost gate above, not a finished result.
Then check `ok` and `stage`.

**`ok` is mechanical**, exactly as in the full skill: `true` only when every slice was
implemented, the adversary read the diff, ran the check and found nothing, no scope
was left uncovered (only the slicer can leave any), no undeclared file was touched
inside another slice's footprint, and nothing was uncommitted at review time.
Otherwise `ok:false` with **`not_ok`** naming the reasons.

The early stops: `stage:'probe'` (a pinned model unusable from this session, nothing
ran); `stage:'recon'` (dirty tree, trunk, not a repo, git missing — report the reason,
not a failed build); `stage:'plan'` (only possible when `slices` was omitted: the
Opus slicer returned none); `stage:'implement'` / `'review'` with an `error` naming
the token budget (the turn's ceiling was nearly spent; `lane_errors` and whatever ran
are in it); `stage:'review'` with `review_missing:true` (implemented but unreviewed —
say "unreviewed" in the headline, never clean); `stage:'implement'` with `never_ran`
non-empty (the runtime dropped those slices before an implementer ran).

Otherwise, report in this order:

1. **`final_review.clean`** — the headline. Anything other than `true` means the work
   is not clean, and you say so plainly before anything about what got fixed.
2. **`repo.executable_checks`** — if `false`, every verdict rests on reading the diff
   alone; say that in the same breath as the headline.
3. **`for_orchestrator`** — everything still unresolved at every severity, namespaced
   `r0:F1` / `r1:F1`, with `re_raises` marking a replaced earlier finding. This is
   yours to close, not the user's — see "Close the leftovers yourself" below.
4. **`implementation`**, **`not_implemented`**, **`lane_errors`**,
   **`footprint_violations`**, **`uncommitted_at_review`** — same meaning as the full
   skill: read files named in `footprint_violations` yourself, since two agents may
   have been in one at once.
5. **`plan.source`** — `'orchestrator'` when your slices ran as given, `'slicer'` when
   the Opus slicer cut them instead. Only when it was the slicer, also report
   `plan.uncovered` (makes the run `ok:false`) and `plan.notes` (informational). With
   orchestrator slices `plan.uncovered` is always empty — scope you left out was yours
   to know, not the engine's to flag.
6. **`patch_rounds[].handed_off`** / **`deferred`** / **`disputed`** — same meaning as
   the full skill.
7. **`models.fallbacks.used`** — say which verdicts came from a fallback model.
8. **`diff_command`** — give the user this last, after you have closed the leftovers,
   so the diff they read is the finished one.

**There is no documents block to report.** `documents.from` is `'slices'` and the rest
of `documents` is empty (`spec: null`, `plan: null`, `decisions: []`) — there is no
"decisions first" section, because the decisions behind this build are the ones you
took when you wrote the slices. Say them yourself, in your own report, the way the
full skill would report `documents.decisions`.

**Never report a clean run when `clean` is not `true`.**

## Close the leftovers yourself — all of them, minors included

Same bargain as the full skill. The engine stops after one patch round and
auto-patches only critical and major findings on purpose — a further round and the
minor patches were measured to cost more than they returned. That only holds if you
actually close the rest. Before you write the report, work through every entry in
`for_orchestrator`, critical first, minors included:

1. Read the finding's `failure_scenario` and the code it names; decide honestly
   whether it is real. A refutation needs the same evidence a patcher's dispute would
   — a command you ran, a line you read.
2. Fix each real one the way `fix_hint` suggests unless you have a better reason, with
   a regression test where the repo can run one. Do not widen scope.
3. Run the repo's check after the fixes and commit, one concern per commit, in the
   repo's convention.
4. Report every entry with its outcome: fixed (with the commit), refuted (with the
   evidence), or left open (with why — which should be rare, and never "it was only
   minor").

## Why these models

The same pinned pair as the full skill: Sonnet where the token volume is — implement
and patch, read/edit/run/re-read — and Opus where the judgement is: the adversarial
review and the re-review. Fable runs only as a fallback tier, never as a primary.
There is no document tier to raise here, because there are no document lanes — this
skill has nothing that corresponds to `docModels:better`. `effort` is the one
expensive knob that remains: it scales output tokens, the priciest meter on every
lane, so raise it only when correctness matters more than cost.

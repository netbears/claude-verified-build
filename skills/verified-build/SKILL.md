---
name: verified-build
description: Run a multi-agent build where Sonnet writes the code in parallel waves of 15, Opus verifies every commit against the real diff and re-runs the repo's own checks, Opus then adversarially reviews the combined diff, and one patch round closes the critical and major findings (the rest come back to you). Works on any git repo in any language or ecosystem — application code, Terraform/OpenTofu, Helm, shell, SQL. Use when the user asks to build, refactor, migrate or fix something non-trivial with verification — "build X with the workflow", "/verified-build", "run the verified build", "implement this and have it reviewed properly". Not for one-line fixes.
---

# /verified-build — write it cheap, verify it independently, then attack it

Sonnet implements. Opus verifies. Opus attacks. Sonnet patches what matters. Opus re-attacks.
Nothing is called done because the model that wrote it said so — and what the last
pass leaves standing is yours to close by hand, not a second round's.

This skill is the entry point; the engine it drives is the saved workflow
`build-verify-patch` (`$CLAUDE_CONFIG_DIR/workflows/build-verify-patch.js`). Deliberately
different names — an identically-named workflow shadows the skill in the registry and
the pre-flight below gets skipped.

**Invoking this skill is the explicit opt-in that permits the Workflow tool.**
You may call `Workflow` for this task without asking again. You may not call it
for anything else in the session on the strength of this skill.

## One agent per slice, always

Slices that declare a common file are *serialised* — they run one after another,
each in its own fresh agent, and each gets its own Opus verifier reading its own
commits. File overlap costs wall-clock and nothing else. The engine never merges two
slices into one context, and never widens what a single verifier has to read.

Two rules the planner now follows, because a serialised slice is not free (every one
is a cold agent reading the repo and its spec): a chain longer than four is merged
into fewer, larger slices, each still with its own agent and verifier; and when the
task points at a plan document, a slice gets its section as a **pointer** (path,
heading, line range) and is told to read only that and the document's global
constraints. Implementers and patchers are handed the planner's `task_summary`,
not your full `task` — so state every hard constraint in a form a summary will
carry, and put the spec's path in the task. Verifiers and the adversary still read
the whole `task`; it remains the bar.

## It is repo-agnostic — do not hand-tune it per repo

Nothing about the engine is specific to one project, one language or one test
framework. A **Recon** agent runs first and establishes, from the repo itself: the
git state, what the repo actually is, and the exact command that proves it still
works — a test suite where there is one, otherwise `validate` / `lint` / `build`.
Everything downstream is handed that one answer.

So do not pre-translate the pattern for a new repo, and do not skip the workflow
because a repo "isn't the kind with tests". Terraform/OpenTofu modules, Helm charts,
shell and SQL all verify fine; `tofu validate` and `tflint` are that repo's tests.
Recon discovering the command once is also what stops fifteen agents each guessing a
different one and disagreeing about what "passing" means.

## Do not reach for this when

- The change is one file and obvious. A ~30-agent run to fix a typo is waste,
  and saying so is the right answer.
- The user wants to watch and steer each step. This runs headless in the background.

**A repo with nothing executable is a degraded run, not a blocked one.** If Recon
finds no runnable check at all, the workflow still runs and says so — every lane
falls back to reading the diff, `repo.executable_checks` comes back `false`, and the
adversary is told it is the only gate. Report that caveat with the result: a clean
verdict from reading alone is real evidence, but weaker than a clean verdict from
something that executed. Only decline outright if the change is trivial.

## Pre-flight

The workflow's agents all share **this session's working directory** and commit into
whatever branch is checked out here.

**Recon enforces three of these for you** and aborts before spending anything on
implementation, returning `ok:false` with a `stage:'recon'` explanation:

- not a git repo, or a repo with no commits yet → stop
- dirty working tree → stop (override: `allowDirty:true`)
- checked out on the repo's shared trunk → stop (override: `allowTrunk:true`)

It works the trunk out from the repo — `origin/HEAD`, the default branch, CI rules —
rather than assuming the name is `main`, so it is right in repos that protect `develop`
or develop on `dev`. When it stops, fix the cause and relaunch; do not reach for the
override just to get moving.

Those three are also free to check yourself: `git status --porcelain` and
`git branch --show-current` cost nothing, whereas a Recon abort costs one agent.
Glance before you launch; rely on Recon to catch what you missed, not to do the
looking for you.

**Two things it cannot do for you:**

1. **Worktrees.** Read the repo's `CLAUDE.md` / `AGENTS.md` and check for
   `.claude/hooks/`. If it mandates a worktree for the paths being touched, or installs
   a hook that DENIES writes outside one (a `worktree-guard.py` under `.claude/hooks/`
   is the usual shape), create the worktree first (`EnterWorktree`, or
   `git worktree add ../<repo>-<slug> -b <branch>`) and launch from inside it. Agents
   inherit the guard; a workflow launched from the wrong directory fails fifteen agents
   deep, not at the start. Recon quotes any such rule it finds in `conventions`, but
   by then the run has already been launched from wherever you were standing.
2. **Orchestrate from Opus.** The workflow script is deterministic JS — the thinking
   that matters at this level is *yours*: writing `task`, and reading the result
   honestly. Opus is the intended orchestrator. If this session is on Fable, switch
   (`/model opus`) or say plainly that you are launching from a Fable session. Fable
   costs ~2x Opus on every meter and draws on a separately-scoped weekly cap, and the
   Plan agent re-does the planning on Opus regardless — so the spend buys nothing.

`testCmd` is now optional: Recon discovers it. Still pass it when you already know it
from this session, or when the repo has several plausible commands and only one is the
one that must pass — an explicit `testCmd` always wins over a discovered one.

## The call

```
Workflow({
  name: 'build-verify-patch',
  args: {
    task:    '<the full task, in as much detail as you would give a good contractor>',
    testCmd: '<optional; exact command, e.g. .venv/bin/python -m unittest discover -s tests>',
  },
})
```

`task` is the only required arg. Write it properly — the planner, every
implementer and the adversary all read it, and the adversary treats it as **the bar
the work must clear**, so a requirement you leave out is a requirement nobody checks.

| arg | default | meaning |
|---|---|---|
| `task` | — | required; the whole ask |
| `testCmd` | discovered by Recon | exact command every lane runs; overrides discovery |
| `wave` | `15` | max agents live at once: parallel groups while implementing, parallel verifiers after (capped at 16, and by the runtime's own `min(16, cpus-2)`) |
| `maxSlices` | `15` | max parallel slices the planner may cut (capped at 20) |
| `maxRounds` | `1` | max review→patch→re-review rounds (capped at 4; `0` = review only, no patching). Was 2 until 2026-09-11 — see "Tuned from six runs" |
| `patchSeverity` | `major` | only findings at or above this severity are auto-patched (`critical` \| `major` \| `minor`); the rest are handed back in `open_findings` and `patch_rounds[].handed_off` |
| `effort` | `high` | reasoning effort for every agent |
| `allowDirty` | `false` | run despite a dirty tree — only when those changes are genuinely part of the task |
| `allowTrunk` | `false` | run on the shared trunk. Almost always the wrong answer; branch instead |
| `fallback` | `true` | retry a lane once on the other tier when its primary model returns nothing (terminal API error such as `529 Overloaded`). `false` disables |
| `judgeFallback` | `fable` | model the Opus judge lanes (plan, verify, adversary, patch-verify) retry on |
| `coderFallback` | `opus` | model the Sonnet lanes (recon, implement, patch) retry on |

Pass a plain string instead of an object and it is taken as `task`.

## While it runs

It is a background run: you get a task id immediately and a notification when it
finishes. **Do not poll it, do not re-invoke it, and never write the result
yourself** — `/workflows` is where the user watches live progress. If they ask
before the notification lands, say it is still running.

## Reading the result

First check `ok`. A run that returned `ok:false` with `stage:'recon'` never started —
report the reason (dirty tree, trunk, not a repo) and what to do about it, rather than
describing it as a failed build.

Otherwise the return value is structured. Report these, and in this order:

1. **`final_review.clean`** — the headline. `true` means the last adversarial pass
   found nothing meeting its bar. **Anything else means the work is not clean**, and
   you must say so plainly rather than leading with what got fixed.
2. **`repo.executable_checks`** — if `false`, nothing was ever executed in this run
   and every verdict below rests on reading the diff. State that in the same breath
   as the headline, not as a footnote.
3. **`open_findings`** — findings still standing. If `stopped_at_round_cap` is true
   these were never patched; the run hit its round limit. That is a real,
   reportable outcome, not a footnote.
4. **`failed_verification`** — slices whose commits a verifier would not sign off.
5. **`plan.uncovered`** — scope the planner admitted dropping up front.
   Also glance at **`plan.groups`** vs **`plan.largest_group`**: a `largest_group`
   equal to the slice count means every slice's declared files overlapped
   transitively, so the run was fully sequential. That is slow, not broken — every
   slice still got its own agent and its own verifier — but it usually means the
   planner (or your `task`) drew the file boundaries badly, and the engine logs a
   WARNING when it happens.
6. **`patch_rounds[].deferred`** — findings dropped past the 15-per-round cap;
   **`patch_rounds[].handed_off`** — findings below `patchSeverity` that were never
   sent to a patcher. They are still in `open_findings`; they are yours to fix by
   hand, and they are usually ten minutes each.
7. **`patch_rounds[].patched[].patch.status === 'disputed'`** — the patcher argued
   the finding was wrong. Surface the dispute and its evidence; do not quietly
   treat it as fixed, and do not quietly treat it as broken either.
8. **`models.fallbacks.used`** — lanes whose primary model returned nothing and were
   re-run once on the fallback tier (`label`, `primary`, `fallback` per entry). Say
   which verdicts came from the fallback model: "verified by Fable because Opus was
   overloaded" is a different sentence from "verified by Opus", and a Fable lane billed
   at ~2x Opus. A lane still `null` after its fallback appears in `failed_verification`
   exactly as before.

Then give the user the diff command from `diff_command` so they can read the whole
thing themselves. `repo.check_command` is what was actually run, and
`repo.other_checks` lists checks Recon found but did not make primary — worth
mentioning if the user asks how thoroughly it was exercised.

**Never report a clean run when `clean` is not `true`.** The entire point of paying
for an adversary is that its verdict survives contact with the summary.

## Tuned from six runs (2026-09-11)

Six runs on one repo (three plans each of five to twelve tasks), 25 hours of wall
clock and ~2.3 billion cached-read tokens, reconstructed phase by phase from every
agent's transcript:

| phase | wall clock | tokens |
|---|---|---|
| recon + plan | 4% | 2% |
| implement | 27% | 27% |
| verify | 12% | 8% |
| adversarial review passes | 10% | 13% |
| patch rounds | **46%** | **51%** |

The patch rounds were the cost *and* the quality problem: in three of three runs a
patch introduced the next round's worst finding, and the second round's net effect
was about zero every time (it closed 4/2/5 findings; the re-review found 5/2/2 new
ones). Peak parallelism was never the wave cap — it was the number of slices, and
only while verifying; implementation ran one or two agents wide because the plans'
file-overlap tables chained the slices.

So, four changes, all in the engine:

1. `maxRounds` defaults to **1**. Leftovers go back to the orchestrator.
2. `patchSeverity` defaults to **major**: minors are not auto-patched. They were
   ~40% of what got patched and where patchers most often invented things.
3. Patchers are **grouped by the file the finding names** and serialised within a
   group, exactly like implementers; verifiers still run in parallel. Before this,
   every patcher ran at once in the shared tree and verifiers kept meeting sibling
   patchers' uncommitted edits.
4. Implementers and patchers get the planner's **`task_summary`** instead of the
   full task, and slices point at their section of a plan document rather than
   reading it whole. Long serial chains are merged (see above).

Not changed, deliberately: one verifier per slice, the full-task adversary, and
the Sonnet/Opus split. The measured fix for the class of defect that slipped three
patch verifiers (a repo guard test outside the smoke set) lives in the repo, not
here: put every closed-vocabulary guard in the smoke set.

## Why these models, and what it costs

The models are **pinned in the workflow, not inherited from your session**: Sonnet
implements, Opus judges, and Fable runs only as a fallback. That is a measured cost
decision, not a preference, and it is the reason this pattern beats doing the same work
by hand.

**Fallback tiers.** `agent()` returns nothing when a subagent dies on a terminal API
error after the runtime's own retries — a `529 Overloaded` storm, typically — and a
verifier that returned nothing is a slice nobody checked. So every lane retries **once**
on the other tier: the Opus judge lanes (plan, verify, adversary, patch-verify) fall back
to Fable, and the Sonnet lanes (recon, implement, patch) fall back to Opus. The retry is
a separate agent with a `:fb-<model>` label, it is recorded in `models.fallbacks.used`,
and the run logs it at the end. It exists because on 2026-09-03 Opus was overloaded for
about ninety minutes, every judge lane returned null, and the run reported `ok:true`
with zero verification. The cost is paid only when a primary fails and only for that
lane; a Fable fallback bills ~2x Opus for it. `fallback:false` disables it,
`judgeFallback` / `coderFallback` change the tiers. One caveat: an agent the user skips
mid-run also returns nothing and gets the same single fallback attempt.

Spend is **context size x number of calls** — cache reads are ~99% of real token
consumption and output is <1%. So the only question that matters is *which model's
meter the repeated context re-reads land on*:

| | input | output | cache read (~0.1x input) |
|---|---|---|---|
| Fable 5 | $10 /Mtok | $50 /Mtok | $1.00 /Mtok |
| Opus 5 | $5 /Mtok | $25 /Mtok | $0.50 /Mtok |
| Sonnet 5 | $2 /Mtok | $10 /Mtok | **$0.20 /Mtok** |

The implement lane is where the volume is — read, edit, run tests, re-read — so it
goes on Sonnet, making those re-reads 5x cheaper than Fable and 2.5x cheaper than
Opus. The judge lanes are low-volume and high-consequence, so they get Opus. Recon is
on Sonnet too: it is mechanical discovery, and it *saves* money by establishing facts
once that every later agent would otherwise pay to rediscover.

A real run is roughly **25-35 agents, ~15-25M tokens, on the order of $15-20 at list
rates**. The same work done step-by-step in one premium-model session lands nearer
$55-70 — not because it uses fewer tokens (it uses slightly more), but because a
single long session's context grows quadratically and every re-read bills at the top
rate. Right for a multi-file feature; badly wrong for a small fix. If the user seems
not to have priced that in, say the number before you launch — once, then do as they
ask.

**`effort` is the expensive knob, not the model.** It scales output tokens, the
priciest meter on every row above. `high` is the default and the sweet spot; reach
for `max` only when correctness matters more than cost, and never as a reflex.

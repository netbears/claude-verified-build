# Changelog

## v1.7.1 — 2026-09-18

**The engine is developed as parts and built into one file.** `workflows/build-verify-patch.js`
had grown to 2,265 lines in one scroll — knobs, lanes, schemas, doctrine, helpers, the
token profile and six phases — so any change meant finding its place in the whole. The
source now lives under `src/`, one part per concern (`10-knobs`, `20-lanes`, `30-schemas`,
`40-doctrine`, `50-helpers`, `60-estimate`) and one per phase (`70-recon`, `80-documents`,
`90-slice`, `92-implement`, `94-review`, `96-report`), and `node build.js` assembles them in
name order into the engine. The built file stays committed, because the Workflow runtime
takes one self-contained script and `install.sh` copies one file to a box that may have no
node; `check.sh` now fails first when the committed engine is not what `src/` builds, so
the two cannot drift. Each section of the built file carries a marker naming its part.

Behaviour is unchanged and was checked to be: the old and the new engine were run against
the same stubbed runtime over seven argument shapes (a fresh launch, both owner pauses with
answers, a fully autonomous run on raised document tiers with two patch rounds, `from:'plan'`
with a `testCmd`, `from:'spec'` with no document review, and no probe with a wave of one) and
every one of the 87 agent calls — label, model, effort, schema and prompt text — every result
and every log line was identical, so a run in flight resumes from cache exactly as before.
Three repeated report shapes became one function each (`documentsReport`, `planReport`,
`docPhase`), the owner-not-asked note the spec and plan writers share is one constant, and
the Probe header no longer sits under the Recon one. The 81 tests pass as they were.

## v1.7.0 — 2026-09-16

**The document lanes can be raised for a run where the design is the risk.** Two new args,
`docWriter` (default `sonnet`) and `docJudge` (default `opus`), move the five document
lanes — the spec writer, the plan writer, both document reviewers, and the author that
records the owner's answers — and nothing else. Recon, the slicer, the implementers, the
patchers and the code adversary stay pinned: the document half is ~10 agents and the design
every later agent inherits, while the code half is one agent per slice plus one per patched
finding, each re-reading the repo, which is where the token volume is. `docModels:better`
is the skill's shorthand for `docWriter:'opus', docJudge:'fable'`; an unqualified run is
byte-for-byte what it was before. Measured on the engine's own profile at a five-slice run:
the document half goes from USD 53 to USD 106 and the code half does not move, so the total
goes from ~USD 101 to ~USD 154 — and the cost gate prices what the caller actually asked
for, because the five `PROFILE` rows follow the knobs. The probe phase probes every primary
the run will use, so a `fable` document reviewer this account cannot reach still costs cents
to discover rather than a whole front half.

**A lane on a third model now has a fallback.** `fallbackFor()` knew only the two pinned
tiers and returned `null` for anything else, so a document reviewer on Fable would have had
no retry at all: one `529 Overloaded` and the run stops at `stage:'spec-review'` with
nothing built — exactly the hole v1.2.0's fallback tiers were added to close. A lane's
fallback is still keyed on its model, `coderFallback` / `judgeFallback` still override the
pinned two, and anything else steps one tier up (`fable` back down to `opus`).

An alias the engine does not know is refused in the run log and that lane keeps its
default, rather than a typo quietly deciding who reviewed the spec. `models` in the result
now reports what actually ran — `spec`, `plan`, `doc_review`, `owner_answers`, `implement`,
`review`, `slice`, `recon`, `probed` — since a result naming the default would misreport
which model gave the verdict. Four tests: the lanes that move and the lanes that do not,
the estimate priced on the raised tiers, the top-tier fallback, and the refused alias.

## v1.6.1 — 2026-09-14

**A fold-in that happened is no longer read as a fold-in that did not.** `git show --stat`
wraps its path column to a terminal width and elides a long path from the LEFT with `...`,
so a document this engine names itself — `docs/specs/<yyyy-mm-dd>-<slug>.md` — comes back
as ` ...-14-<slug>.md | 284 ++++---`, the basename's own date prefix gone. `docEditUnproven`
matched the basename literally, so on 2026-09-14 a stonks-v2 run stopped at
`stage:'spec-review'` on a spec whose review had been folded in correctly and committed
twice over: the reviewer's commit was rejected, the editor lane sent after it committed a
further re-measurement of every cited line range, and its `--stat` was rejected for the
same reason. Nothing was sliced; the spec on the branch was complete and correct the whole
time.

`statListsDoc` now compares the way git prints it — each stat row's path cell, a leading
`...` dropped, accepted when the document's full path ends with what is left (a rename
row's target is taken last). The full path and the plain basename still match as before,
and an elided path for a *different* file is still no proof, so the gate keeps its teeth.

## v1.6.0 — 2026-09-13

**The owner is asked before the spec is written, and the writer starts from a map.** On
the 2026-09-11 run the spec stage was 27 of the front half's 92 minutes: the writer
rediscovered where the idea lands, the reviewer re-read the same repo to check it, and an
owner question raised by the writer meant a provisional decision the reviewer folded
around, a pause after the review, and an Opus author lane to rewrite the document with the
answer. From an idea, Recon — which reads the repo anyway — now also reports
`touchpoints` (the files and `grep -n`-measured line ranges the spec will have to read or
change, and why) and `owner_questions` (the money / risk / data / ownership / reversal
questions a careful colleague would put before designing). Those questions pause the run
at `stage:'idea'` with `document:null` before the spec writer runs; on the resume the
writer gets the map and the answers, writes them into "Decisions taken by the owner"
itself, and is told never to re-raise them; with `pauseForOwner:false` it is told the
recommended option stands. No answers lane runs for an idea question, the plan writer
sees the idea answers with the spec's, and Recon's prompt never carries the answers, so it
replays from cache. The spec and plan writers and reviewers still raise the questions
that only emerge during design, as before. Answer ids now look like `idea:Q1` as well as
`spec:Q1` / `plan:Q1`. Two tests; the helpers test loads the question schema alongside
Recon's, which now references it.

## v1.5.2 — 2026-09-13

**SKILL.md matches the engine again.** Checked line by line against the engine. Recon's
other checks are reported but never run (Recon has executed only the fastest real check
since v1.4.0; the skill still said it ran them all). The Opus-orchestrator note no longer
says the Plan agent re-plans on Opus. The plan reviewer can raise owner questions too, and
a finding that would reverse an owner decision is withdrawn by the reviewer, not refuted.
Reading the result now covers a round's `edit` (the editor lane wrote the fold-in, not the
reviewer) and the `spec` / `plan` / `doc_review` fields of `models`, and says that a
review with no findings needs no commit. Documentation only.

## v1.5.1 — 2026-09-13

**A document review is folded in only when the document changed.** The spec and plan
reviewers were told to fold their findings in and commit, but the engine took their word:
a review that marked findings `folded` without editing the file, or without a commit, only
logged a warning, and the next stage read an unchanged document. The reviewer prompt now
says the reviewer edits the file itself ("findings you only list are not a review") and
adds a Part 3: paste `git show --stat <commit> -- <document>` into a new required
`document_diff_stat`. The engine checks every review with findings for a new commit — not
the writer's, not the previous round's — whose stat lists the document. One that fails gets
a single Opus editor lane (`spec-edit:rN` / `plan-edit:rN`) with the findings and their
dispositions; if the editor fails the same check or returns nothing, the run stops at
`stage:'spec-review'` / `'plan-review'` with the reason, before anything is sliced.
`changed` is now required on every finding. The fold's `commit_sha` is the editor's when
one ran, each round carries `edit`, and the cost gate counts an editor as a `doc_review`
agent. Two tests, and two assertions on the existing ones.

## v1.5.0 — 2026-09-13

**Sonnet writes the spec and the plan; Opus still reviews both.** The spec writer and the
plan writer move from `opus` to `sonnet`. The spec review and the plan review (each still
folding its own findings in), the owner-answer authors, the slicer, the adversary and the
re-review stay on Opus. Every document a writer commits is attacked by an Opus reviewer that
must bring evidence before anything is built, so the writer need not be the judge; the plan
writer was 16.8 of the front half's 92 minutes on the 2026-09-11 run, and its re-reads now
bill at the Sonnet rate. A writer that returns nothing retries on Opus (`coderFallback`),
like the other Sonnet lanes. The cost gate prices the `spec` and `plan_doc` rows at Sonnet
(still `measured:false`), and `models` in the result names `spec`, `plan` and `doc_review`.
One test.

## v1.4.2 — 2026-09-12

**The slicer has a `notes` field, so `uncovered` holds only dropped scope.** On the 2026-09-12
run the slicer wrote four explanatory paragraphs into `uncovered` — the first of them "Nothing in
the plan's 23 tasks is dropped" — and the engine, which reads that array mechanically, reported
`ok:false` with "the slicer left scope uncovered" over a build that had covered everything. The
schema and the prompt now say that any `uncovered` entry makes the run not ok and that caveats,
cross-slice dependencies and things the task itself keeps outside every slice go in `notes`,
which is logged and returned as `plan.notes`. One test.

## v1.4.1 — 2026-09-12

**The engine no longer reads the wall clock.** The Workflow runtime forbids `Date.now()`,
argless `new Date()` and `Math.random()` in a script (a script must replay identically on
resume) and now rejects the script text statically, before Recon runs: a launch on
2026-09-12 died in 18 ms with "Date.now() / new Date() are unavailable in workflow scripts".
Lane timing used `Date.now()` in three places. It now uses `performance.now()` where the
sandbox exposes it and reports `null` seconds where it does not — the sandbox exposes no
clock at all today (probed 2026-09-12: `performance` undefined, no `process.hrtime`), so
`timing.run_wall_clock_seconds` and every lane's `seconds` come back `null` in a real run
and `agent_seconds_by_phase` sums to zero; the per-run wall clock is in the task
notification's `duration_ms` instead. Two tests: a run with no clock still completes with
finite phase sums, and the engine text contains none of the three forbidden calls.

## v1.4.0 — 2026-09-12

**The front half, measured and trimmed.** One full run on 2026-09-11 (five slices, one owner
question, one patch round), reconstructed from its 29 agent transcripts: 223 minutes wall
clock, of which 73 waiting for the owner and 150 with agents active — and 92 of those 150 in
the front half. Recon 7.4, spec 9.4, spec review 8.4 + fold-in 9.3, plan 16.8, plan review
22.4 + fold-in 7.1, decision record 5.8 + plan index 0.4, slice 2.2. Four changes:

- **Recon runs one check, once, under `timeout 180`,** the fastest real one, and reports the
  rest unexecuted. It used to run every command it found; on that run it started the full
  suite in the background and spent half its 67 tool calls watching the process (ps, /proc,
  strace, pg_stat_activity). The adversary re-runs the check anyway.
- **The plan review reads and compiles; it never runs the tests or splices a task into a
  worktree.** Its three real findings on that run were ones the implementers hit in their own
  red-green cycle a phase later; the worktree work was 22 minutes and 77 tool calls.
- **Review and fold-in are one lane per document.** The reviewer lists its findings with
  evidence, then re-verifies each before folding it in; a finding that does not survive, or
  that would reverse a recorded owner decision, is `withdrawn` with the reason. The separate
  fold-in author was a second cold read of the document and the repo, 16 minutes on that run,
  and refuted 0 of 17 findings. `spec_reviews[].fold` / `plan_reviews[].fold` keep their
  shape (`folded`, `refuted`, `commit_sha`), derived from the same agent's dispositions.
- **The consolidated decision recorder is gone.** It re-wrote 45 decisions that already sat in
  the documents' own tables (the spec writer's, the plan's, each fold-in record, the owner's
  answers). `documents.decisions` still carries every one in order; `documents.decision_record`
  and `stage:'record'` are gone. With `pauseForOwner:false` the writers and reviewers now
  write the recommended option in as the decision, marked "owner not asked", instead of
  leaving a "pending owner" marker for a recorder to resolve. The plan is still re-measured
  when a fold-in or the owner's answers committed into it.

Expected on that run: the front half from 92 to about 60 minutes, the whole active run from
150 to about 95 (with v1.3.0's cuts). The `doc_review` profile row now covers both halves of
the lane; `doc_fold` and `record` are gone, and `doc_review` counts the plan's review too (it
counted only the spec's before). 68 tests.

## v1.3.0 — 2026-09-12

**The per-slice verifier and the per-patch verifier are gone; the adversary runs the check.**
Measured over six runs the Verify phase was 12% of wall clock and 8% of tokens, and every
verdict it produced was re-derived by the next gate: the adversary was handed the
verification results and told to hunt for "anything a verifier marked verified:true that
the diff does not support". Each verifier read its own slice's commits, which the adversary
reads again in the combined diff; asked whether the slice did what it said, which the
adversary is asked across every slice; reported `git status`, which the adversary reports;
and ran the check command — N times, on the same tree, because a shared checkout cannot be
rewound per commit. The patch verifier was the same shape one phase later: the re-review's
first job is "is each patched finding genuinely closed", and the verifier sat inside every
patch group's serial chain.

So the run goes Implement → Adversarial review → Patch → Re-review. What moved rather than
vanished: the adversary now runs the check itself and reports `executed`, `commands_run`
and `output_tail` (a failing check is a critical finding); where the repo has a check, a
review with `executed:false` is never `clean` and is a `not_ok` reason; the verifier's hunt
list (files outside the declared set, weakened or skipped tests, TODO stubs, commented-out
assertions, swallowed exceptions, hardcoded values) is in the adversary's; the adversary
receives the implementers' own reports labelled as claims; the re-review receives the
patchers' reports and each finding's failure scenario, and is asked whether the regression
test would pass on the old code. A patch reported `fixed` closes on the patcher's word plus
the re-review's silence — that was already the rule; the verifier's signature was a third
opinion the re-review overrode either way.

Gone from the result: `failed_verification`, `implementation[].verified` / `.problems`
(`implementation` is now the raw implementer reports), `patch_rounds[].patched[].verify`,
`models.verify`, `stage:'verify'`, and the `verify` / `patch_verify` rows of the cost
profile — an estimate for the same plan is correspondingly lower. Within a patch group the
next patcher starts when the previous one finishes, not when its verifier does.

**Every lane is timed.** The result carries `timing`: the run's wall clock, agent-seconds per
phase, and one entry per lane; the log prints each lane's seconds as it finishes. The front
half had never been measured, so the next cut can be argued from a number. 68 tests.

## v1.2.0 — 2026-09-11

Every guarantee the skill claimed that the engine did not enforce, from an adversarial
review of v1.1.1 by a different model; twenty findings, fifteen confirmed against the code
and closed, five that were design choices the documents now state plainly.

**The verdict is mechanical.** `ok` was `!review_missing && never_ran.length === 0`, so a
run with a slice nobody implemented, a slice that failed verification, a reviewer who said
`clean:true` over a list of findings or without reading the diff, scope the slicer admitted
dropping, or edits still uncommitted at review time came back `ok:true`. Now `clean` is
derived (diff read AND no findings; the reviewer's own word kept as `claimed_clean`),
`verified:true` without `executed:true` is downgraded where the repo has checks, both
judges report `git status --porcelain` and the first review's dirty paths count against
the run (`uncommitted_at_review`), `plan.uncovered` counts against it, and `ok` is true
only when `not_ok` — the list of reasons, in words — is empty.

**The shared tree is guarded, not just asked nicely.** Implementers and patchers commit by
pathspec (`git commit -- <files>`), which takes only the named paths whatever a sibling has
staged in the shared index. A slice with no declared files, or a finding without a file,
has an unknown footprint and runs with nothing else live, after the grouped ones.
`src/**/*.py` now overlaps `src/a.py` (`**/` spans zero or more directories). Every file
an implementer reports touching outside its slice is compared with what the other groups
declared; a hit is a `footprint_violation`, shown to the adversary and held against the
run. Findings may carry `files` (the test file included) so patchers sharing a helper are
serialised. Within a patch group the verifier now completes before the next patcher
starts; it used to run the checks while that patcher edited the same file.

**The front half asks every question and stops where a gate was lost.** Two different
questions with the same local id (the spec writer's Q1, the reviewer's Q1) collapsed to
one; the second is now suffixed `-2`, and only a true duplicate is dropped. The plan
writer can escalate `open_questions`, so a destructive sequencing choice pauses the run
instead of landing as an engine decision. An answers author, a document reviewer, a
fold-in author or the recorder that returned nothing used to be a log line while the build
went on (with the owner's answer claimed as recorded); each is a stop now — `stage:'spec'`
/ `'plan'`, `'spec-review'` / `'plan-review'`, `'record'` — and the resume replays from
cache. The plan is measured once, after the last agent that writes into it (the recorder
included), so slice pointers are current.

**Smaller.** An explicit `testCmd` wins over Recon's `has_executable_checks:false`. A
negative price override is ignored. Nested braces in a declared path are pinned by a test.

**Stated, not changed.** One check command is the gate (the rest are `repo.other_checks`);
verifiers run it on the tree after the implement phase, not checked out per commit; a patch
reported fixed and signed off by its verifier is closed on those two agents' word unless
the re-review re-raises it; the document reviewers are Opus attacking Opus, independent by
agent, not by model; Recon runs the check commands it finds before any gate. 63 tests.


## v1.1.1 — 2026-09-11

Two things the first live run of the front half taught. Recon's `today` is required with a
`YYYY-MM-DD` pattern the runtime enforces: it was optional, Recon omitted it, and the plan
writer named its file `undated-<slug>.md` (the fallback now also logs a warning). The skill
writes prices as `USD 1.00`: the skill loader substitutes `$0` and `$1` with the invocation's
argument words, so `$1.00` rendered as garbage whenever the skill was invoked with arguments.

The live run itself (one slice, a `stonks version` command on a Python repo, 15 agents, 54
minutes end to end at API list prices ~USD 109 estimated): probe, recon, spec + 7 findings
folded, plan + 3 findings folded, decision record with 35 entries, cost-gate pause and
resume from cache, one implementer, one verifier, one adversarial pass returning three
minors and no majors, all three closed by the orchestrator by hand. No lane errors, no
fallbacks.


## v1.1.0 — 2026-09-11

Every gap an adversarial review of v1.0.0 found, closed; a test suite; a model probe.

**Wrong outcomes fixed.** A slice that bridged two file groups ran before the earlier task
it consumed from (`s1 > s3 > s2`); groups now keep the plan's order. A declared directory,
glob or `..` path never collided with the files under it, so two agents could share a file;
`pathsOverlap` now treats a directory as covering its contents and a glob as matching what
it could match. A lane that threw inside `parallel()` silently dropped its whole group;
`callAgent` never throws now, every failure lands in `lane_errors`, `not_implemented` and
`never_ran` name the slices, and the token budget stops the run between phases with a
report. An adversary that returned nothing after its fallback read as a clean run; it is
`ok:false, review_missing:true` now, and with no final review every patched finding is
carried. A finding whose patch failed, was disputed or was not signed off fell off the
orchestrator's list unless the re-review re-raised it; `collectForOrchestrator` carries all
of them, and a re-review marks a genuine re-raise with `re_raises`. Finding ids are
namespaced by round (`r0:F1`), so a round-1 minor is no longer conflated with a new `F1`.

**Cost gate fixed.** Fable's cache-read price was 0.25 (below Opus); it is 1.00, as the
skill's table always said. A partial `prices` override replaced a whole row and turned every
cost into `null`, which then passed any `maxUsd`; overrides merge per field and `maxUsd`
passes only a finite total. The low–high band is described as what it is: a fixed 0.6x–1.6x.

**Front half.** Answers are sorted by id, so a resume replays the answers author whatever
order the orchestrator passed them in. Fold-in dispositions (folded, refuted with evidence)
are on the decision record, as the skill claimed. The plan re-measure keeps the plan
writer's decisions. A path-shaped `task` is handed to Recon, the slicer, the verifiers and
the adversary as "read this document", not as a bare path.

**New.** A Probe phase sends one tool-free call each to `sonnet` and `opus` before Recon
and stops with `stage:'probe'` if this account cannot use one (`probeModels:false` skips).
Implementers are told to stage by file name and never sweep the shared tree. A patcher that
returned nothing or reported `failed` gets no verifier. The unused `waves()` is gone; the
slicer sits under the Slice phase.

**Repo.** `test/helpers.test.js` and `test/engine.test.js` (the whole engine against a
stubbed runtime, 35 tests); `check.sh` runs them and works on BSD `mktemp`; `install.sh`
checks git, node, ssh/scp and a checksum tool, runs `check.sh` before copying, no longer
creates a literal `~` directory on remote hosts, and works with macOS `md5`; CI on both
remotes; `.gitignore`. README gains "What a run executes, and where" and the known limits;
the skill's cost paragraph now matches the measured figures instead of contradicting them.


## v1.0.0 — 2026-09-11

The first tagged release. One skill, one engine, an installer, a checker.

**The run, end to end.** From an idea, a spec or a plan (`from`): Recon → Spec → Spec
review and fold-in → Plan → Plan review and fold-in → Decision record → Slice → cost gate →
Implement → Verify → Adversarial review → one Patch round → Re-review → the orchestrator
closes every leftover by hand. Sonnet implements and patches; Opus writes the documents,
reviews, verifies and attacks; Fable and Opus are the fallback tiers when a lane's primary
model returns nothing.

**Three pauses, one shape.** Owner questions after the spec and after the plan (options,
consequences, a recommendation; the recommended option stands as the provisional decision
marked "pending owner"); the cost gate before implementation (USD at API list prices, with
a low–high band and the share resting on assumptions). Each returns `paused:true`; the same
run resumes with the answer, everything before it replayed from cache.

**Documents.** Spec and plan are written under the repo's own convention (`docs/specs`,
`docs/plans` by default) and committed on the branch as they are written, folded and
answered; a decision record — every decision, by whom and why — is written into both before
the first line of code. Merging the branch puts the final documents on the trunk with the
code.

**Defaults tuned from six measured runs** (9–11 Sep 2026; 25 h, ~2.3 B cached-read
tokens): `maxRounds=1`, `patchSeverity=major`, patchers grouped by the file a finding
names and serialised within a group, implementers and patchers handed the planner's
`task_summary` rather than the full task, plan tasks given as pointers, serial chains
longer than four merged. The second patch round was measured to return about nothing and to
introduce the next round's worst finding; minor findings were where patchers drifted.

**Doctrine embedded per role** from the superpowers skills (MIT, Jesse Vincent), adapted
only where a stage has no human to ask. No plugin dependency: an install is two file copies.

**Reporting contract.** `documents.decisions` first, then `final_review.clean`,
`repo.executable_checks`, `for_orchestrator` (every unresolved finding at every severity,
which the orchestrator closes before reporting), `failed_verification`, `plan.uncovered`,
disputed patches, fallback lanes, and `cost` — the estimate beside the actual output tokens.

**Known limits.** The front half (spec, plan, their reviews, the recorder) has not been run
end to end at this release; its token-profile rows are assumptions and labelled so in the
estimate. Patchers share the working tree (grouped by file, not isolated in worktrees);
collisions on a shared test file remain possible across groups.

# Changelog

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

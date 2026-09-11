# Changelog

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

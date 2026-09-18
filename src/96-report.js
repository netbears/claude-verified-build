// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const openFindings = review ? review.findings : []
const stoppedEarly = round >= MAX_ROUNDS && openFindings.length > 0
// The first review runs at the barrier after every implementer has finished, so the
// tree should be clean there; anything it found uncommitted is work outside the diff.
const uncommittedAtReview = firstReview ? firstReview.dirty_paths : ''

// Everything the orchestrator must close by hand, at EVERY severity — see
// collectForOrchestrator for what counts. With no final review, every patched
// finding is carried too, because nothing confirmed it closed.
const forOrchestrator = collectForOrchestrator(openFindings, rounds, !reviewMissing)
const bySeverity = { critical: 0, major: 0, minor: 0 }
for (const f of forOrchestrator) bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1
if (forOrchestrator.length) {
  log('FOR THE ORCHESTRATOR TO CLOSE BY HAND: ' + forOrchestrator.length + ' finding(s) — ' +
    bySeverity.critical + ' critical, ' + bySeverity.major + ' major, ' + bySeverity.minor + ' minor: ' +
    forOrchestrator.map((f) => f.id + ' (' + f.severity + ')').join(', '))
}

if (stoppedEarly) {
  log('STOPPED at the ' + MAX_ROUNDS + '-round cap with ' + openFindings.length + ' finding(s) still open')
} else if (openFindings.length === 0) {
  log('adversarial review came back clean after ' + round + ' patch round(s)')
}

if (fallbacksUsed.length) {
  log(fallbacksUsed.length + ' lane(s) ran on a FALLBACK model after the primary returned nothing: ' +
    fallbacksUsed.map((f) => f.label + ' -> ' + f.fallback).join(', '))
}
if (laneErrors.length) {
  log(laneErrors.length + ' lane failure(s) recorded: ' + laneErrors.map((e) => e.label + ' (' + e.error.slice(0, 60) + ')').join(', '))
}

// ok is mechanical: true only when the run completed AND every gate passed. Every
// reason it did not is listed in not_ok, so a consumer keying off ok alone cannot
// mistake a half-built, unexecuted, unreviewed or dirty run for a success. The rest
// of the report is still here either way — the work exists on the branch.
const notOk = []
if (reviewMissing) notOk.push('the adversarial review returned nothing after its fallback: the work is unreviewed')
if (neverRan.length) notOk.push(neverRan.length + ' slice(s) never ran: ' + neverRan.join(', '))
if (notImplemented.length) notOk.push(notImplemented.length + ' slice(s) not implemented (no implementer result): ' + notImplemented.join(', '))
if (plan.uncovered && plan.uncovered.length) notOk.push('the slicer left scope uncovered: ' + plan.uncovered.join(' | '))
if (violations.length) notOk.push(violations.length + ' undeclared file(s) touched inside another group\'s footprint: ' + violations.map((v) => v.slice + ' -> ' + v.file).join(', '))
if (uncommittedAtReview) notOk.push('uncommitted changes in the tree at review time (not in the reviewed diff): ' + uncommittedAtReview.slice(0, 300))
if (review && review.diff_reviewed !== true) notOk.push('the final review did not read the diff (diff_reviewed:false)')
if (review && HAS_CHECKS && review.executed !== true) notOk.push('the final review did not run the check command (executed:false): nothing independent executed the suite')
if (review && openFindings.length) notOk.push('the final review is not clean: ' + openFindings.length + ' finding(s) open')
if (notOk.length) log('NOT OK — ' + notOk.join('; '))

return {
  ok: notOk.length === 0,
  not_ok: notOk,
  ...(reviewMissing ? { stage: 'review', error: 'the adversarial review returned nothing after its fallback; the work on the branch is UNREVIEWED and every finding of the last round is carried in for_orchestrator', review_missing: true } : { review_missing: false }),
  ...(neverRan.length ? { stage: 'implement', error: neverRan.length + ' slice(s) never ran: ' + neverRan.join(', ') } : {}),
  task: TASK,
  base_sha: BASE,
  diff_command: DIFF_CMD,
  repo: {
    ecosystem: recon.ecosystem || '',
    branch: recon.branch || '',
    check_command: CHECK_CMD || null,
    // The honest caveat: false means no lane in this run executed anything, so
    // the review's verdict rests on reading alone. Report it, do not bury it.
    executable_checks: HAS_CHECKS,
    other_checks: (recon.verify_commands || []).slice(1),
  },
  paused: false,
  // The pre-build estimate, and the one actual figure the runtime exposes: output tokens
  // spent this turn across the main loop and every workflow. Compare the two.
  cost: { estimate: estimate, output_tokens_actually_spent_this_turn: budget.spent() },
  patch_policy: { max_rounds: MAX_ROUNDS, auto_patch_at_or_above: PATCH_SEVERITY },
  // The front half: where the run started, the documents it wrote and committed, every
  // adversarial review and fold-in of them, and — first thing to report — every decision a
  // writer took because there was no owner to ask.
  documents: { ...documentsReport(), doc_rounds: DOC_ROUNDS, pause_for_owner: PAUSE_FOR_OWNER },
  models: {
    // What actually ran, not what the engine pins by default: docWriter / docJudge move
    // the first four of these, and a result that named the default would misreport which
    // model reviewed the spec.
    spec: DOC_WRITER, plan: DOC_WRITER, doc_review: DOC_JUDGE, owner_answers: DOC_JUDGE,
    implement: CODER, review: JUDGE, slice: JUDGE, recon: CODER, probed: PRIMARY_MODELS,
    effort: EFFORT, max_concurrent: WAVE,
    // Lanes whose primary model returned nothing and were re-run once on the other
    // tier. A verdict from a fallback lane is still a verdict, but say which model gave it.
    fallbacks: { enabled: FALLBACK, coder: CODER_FALLBACK, judge: JUDGE_FALLBACK, used: fallbacksUsed },
  },
  plan: planReport(),
  // The implementers' own reports, unjudged: the adversary's findings are the verdict on them.
  implementation: implReports,
  // Slices the runtime dropped before an implementer ran, and slices whose implementer
  // (and its fallback) returned nothing: neither has a commit to review.
  never_ran: neverRan,
  not_implemented: notImplemented,
  uncommitted_at_review: uncommittedAtReview,
  // Files an implementer touched outside its slice that another group had declared:
  // two agents may have been inside that file at once.
  footprint_violations: violations,
  // Every lane that returned nothing or threw, primary or fallback, with the reason.
  lane_errors: laneErrors,
  // Where the minutes went: wall clock for the run, agent-seconds per phase, and every lane.
  timing: timingByPhase(laneTimings, elapsed(RUN_T0)),
  patch_rounds: rounds,
  final_review: review,
  open_findings: openFindings,
  // The complete to-do for the orchestrator, every severity included (minors too):
  // the last review's findings plus everything handed off or deferred in any round.
  // The skill makes closing ALL of these, by hand, the orchestrator's last step.
  for_orchestrator: forOrchestrator,
  for_orchestrator_by_severity: bySeverity,
  stopped_at_round_cap: stoppedEarly,
}

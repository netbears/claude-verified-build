// ---------------------------------------------------------------------------
// Phase 3 — Adversarial review. BARRIER: the adversary needs the whole diff, and it is
// the one lane that executes the check after the implementers' self-reported runs.
// There is no per-slice verifier: every slice's verifier used to run the same check on
// the same tree (a shared checkout cannot be rewound per commit) and hand a verdict to
// the adversary, which was told to re-check it against the diff anyway. Measured over
// six runs the phase was 12% of wall clock and 8% of tokens for verdicts the next gate
// re-derived. The verifier's hunt list and its check run moved into the adversary.
// ---------------------------------------------------------------------------
function reviewPrompt(roundLabel, extra) {
  return [
    'You are the ADVERSARIAL REVIEWER. Your job is to REFUTE the claim that this work is complete and correct.',
    'You are not here to be reassuring, and a clean verdict you cannot defend is worse than a false alarm.',
    '',
    'OVERALL TASK — this is the bar the work must clear:',
    TASK_TEXT,
    '',
    (PLAN_PATH ? 'THE PLAN DOCUMENT THE WORK MUST MATCH, task by task: ' + PLAN_PATH + (SPEC_PATH ? ' (spec: ' + SPEC_PATH + ')' : '') : ''),
    'THE SLICES THAT WERE EXECUTED:',
    JSON.stringify(plan.slices.map((s) => ({ id: s.id, title: s.title, done_when: s.done_when })), null, 2),
    (plan.uncovered && plan.uncovered.length ? '\nThe planner already admitted leaving out: ' + plan.uncovered.join(' | ') : ''),
    (violations.length ? '\nIMPLEMENTERS THAT TOUCHED A FILE ANOTHER SLICE DECLARED (two agents may have edited it at once — read those files with suspicion):\n' +
      violations.map((v) => '  ' + v.slice + ' touched ' + v.file + ', declared by ' + v.collides_with.join(', ')).join('\n') : ''),
    '',
    'WHAT THE IMPLEMENTERS CLAIM — their own reports. Claims, not evidence: checks_passed is self-reported and',
    'nobody has re-run anything since. Read the notes for files touched outside a slice and for anything left undone:',
    JSON.stringify(implReports, null, 2),
    '',
    (extra || ''),
    'READ THE ACTUAL DIFF YOURSELF — do not review the reports:',
    '  ' + DIFF_CMD,
    'Set diff_reviewed:true only if you ran that and read the output.',
    'Then run `git status --porcelain` and report it verbatim in dirty_paths: anything uncommitted is work the',
    'diff does not contain, and a check that passed on it proves nothing about the branch.',
    (HAS_CHECKS
      ? 'RUN THE CHECK YOURSELF. ' + TEST_LINE + ' You are the only lane in this run that executes it after the code\n' +
        'was written: paste the real tail into output_tail, the command into commands_run, and set executed:true. A\n' +
        'failing check is a finding (critical) with the output as its failure_scenario. A review that did not run\n' +
        'the check is executed:false and can never be clean. If you could not run it (broken env, missing\n' +
        'credentials), say so plainly and return executed:false.'
      : 'There is nothing executable in this repo. ' + TEST_LINE + ' Set executed:false and checks_available:false.'),
    '',
    'THE REPO YOU ARE REVIEWING: ' + (recon.ecosystem || 'unknown') +
    (HAS_CHECKS ? '. Its check command is: ' + CHECK_CMD : '. It has NO executable checks.'),
    (recon.conventions ? 'Conventions it documents, which a violation of IS a finding:\n' + recon.conventions : ''),
    '',
    'HUNT SPECIFICALLY FOR:',
    '- Requirements in the task that NO slice implemented. The gap the plan itself missed is the finding no',
    '  single implementer could see, and it is the main reason you exist.',
    '- Integration seams: an assumption slice A relies on that slice B quietly changed.',
    '- Behaviour the diff changes that no test or check covers.',
    '- Edge and error paths: empty, null, zero, negative, very large, unicode, concurrent, partial failure.',
    '- Anything an implementer reported done, or a check it reported passed, that the diff does not support.',
    '- Files touched outside a slice\'s declared set; tests or checks weakened, skipped or deleted to make things',
    '  pass; TODO stubs standing in for the work; commented-out assertions; except/catch blocks that swallow the',
    '  error a check was supposed to surface; a value hardcoded where it should be derived.',
    '- Defects in whatever idiom this repo is written in, not just general-purpose code smells. For infrastructure',
    '  that means things like a resource replaced where it should be updated in place, state or lifecycle rules',
    '  dropped, a hardcoded account/region/environment, a secret committed, a permission widened beyond the task,',
    '  or a change that silently destroys data on apply. Judge the diff on its own terms.',
    '',
    DOCTRINE_REVIEW_CALIBRATION,
    'RULES:',
    '- Under uncertainty, default to raising the finding. A false positive costs one patch; a false negative ships.',
    (HAS_CHECKS
      ? ''
      : '- Nothing here can be executed, so the diff is the only evidence. Weigh it accordingly and say so in summary.'),
    '- Every finding needs a concrete failure_scenario: specific inputs or state leading to a specific wrong',
    '  result. "This is fragile", "consider extracting", "could be clearer" are NOT findings — drop them.',
    '- Style, naming and formatting are not findings unless the repo\'s own documented convention is violated.',
    '- clean:true ONLY if you read the whole diff' + (HAS_CHECKS ? ', ran the check and saw it pass,' : '') + ' and found nothing meeting that bar. Say so in summary.',
    '- You review. You do not fix, and you do not commit.',
    (roundLabel ? '\nThis is ' + roundLabel + '.' : ''),
  ].join('\n')
}

// Finding ids are namespaced by the review that raised them ("r0:F1", "r1:F1"): every
// reviewer numbers from F1, and a round-1 handed-off F3 used to be conflated with a
// brand-new F3 from the re-review. `re_raises` (set by a re-review) refers to these ids.
function stampReview(rev, n) {
  if (!rev) return rev
  const judged = judgeReview(rev, HAS_CHECKS)
  return { ...judged, findings: namespaced('r' + n, judged.findings) }
}

phase('Review')
if (!budgetLeft(40000)) return outOfBudget('review', { never_ran: neverRan, not_implemented: notImplemented, implementation: implReports })
let review = stampReview(await callAgent(reviewPrompt('the first review', ''), {
  label: 'adversary:r0',
  phase: 'Review',
  model: JUDGE,
  effort: EFFORT,
  schema: REVIEW_SCHEMA,
}), 0)
const firstReview = review
// True when the LAST review lane (first or a re-review) returned nothing after its
// fallback. Then nothing is known to be closed and the result says so, loudly.
let reviewMissing = !review
if (reviewMissing) log('WARNING: the adversarial review returned nothing after the fallback — this work is UNREVIEWED')

// ---------------------------------------------------------------------------
// Phase 4 — Patch rounds. Stops the moment a review comes back clean.
// ---------------------------------------------------------------------------
const rounds = []
let round = 0

while (
  round < MAX_ROUNDS &&
  review &&
  review.clean !== true &&
  Array.isArray(review.findings) &&
  review.findings.length > 0
) {
  if (!budgetLeft(60000)) {
    log('stopping before patch round ' + (round + 1) + ': ' + Math.round(budget.remaining() / 1000) + 'k tokens left in budget')
    break
  }
  round++
  phase('Patch')

  const ranked = [...review.findings].sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
  const eligible = ranked.filter((f) => severityRank(f.severity) <= severityRank(PATCH_SEVERITY))
  const handedOff = ranked.filter((f) => severityRank(f.severity) > severityRank(PATCH_SEVERITY))
  if (eligible.length === 0) {
    round--
    log('no finding at or above "' + PATCH_SEVERITY + '" — nothing to auto-patch; ' + handedOff.length +
      ' finding(s) handed to the orchestrator: ' + handedOff.map((f) => f.id).join(', '))
    break
  }
  const take = eligible.slice(0, MAX_PATCH_PER_ROUND)
  const deferred = eligible.slice(MAX_PATCH_PER_ROUND)
  log('round ' + round + ': patching ' + take.length + ' finding(s)' +
    (deferred.length ? ', DEFERRING ' + deferred.length + ' — ' + deferred.map((f) => f.id).join(', ') : '') +
    (handedOff.length ? '; ' + handedOff.length + ' below "' + PATCH_SEVERITY + '" handed to the orchestrator' : ''))

  // Patchers used to run all at once in the shared tree, one per finding, and kept
  // meeting sibling patchers' uncommitted edits. Same cure as the implement phase:
  // findings that name the same file run one after another, groups run in parallel.
  // No per-patch verifier: the re-review reads every patch diff, judges whether the
  // finding is genuinely closed and runs the check — the same verdict the verifier
  // gave, re-derived, so the verifier was a second serial lane per patch for nothing.
  const patchGroups = groupByFileConflict(take.map((f) => ({ id: f.id, files: patchFootprint(f), finding: f })))
  log('round ' + round + ': ' + take.length + ' patch(es) in ' + patchGroups.length + ' file-disjoint group(s)')

  function patchOne(f) {
    return callAgent(
        [
          'You are the PATCHER. Fix exactly one review finding.',
          '',
          'THE TASK IN BRIEF (context only; obey every constraint in it):',
          TASK_BRIEF,
          '',
          'THE FINDING:',
          JSON.stringify(f, null, 2),
          '',
          DOCTRINE_DEBUG,
          'RULES:',
          '- Fix this finding. Do not refactor, tidy or improve anything beyond it — a patch round is the worst',
          '  possible moment to widen scope.',
          (HAS_CHECKS
            ? '- Add a regression test that FAILS before your fix and PASSES after. Verify both directions if you can.\n' +
            '  If this repo has no test framework, add whatever check it DOES support that would have caught this\n' +
            '  (a lint rule, a validate step, an assertion in an existing script). If nothing is possible, say why\n' +
            '  in regression_test rather than leaving it blank.\n' +
            '- ' + TEST_LINE + ' Run the whole thing, not just your new case.'
            : '- ' + TEST_LINE + ' So there is no regression test to add: explain in regression_test what would have\n' +
            '  caught this if the repo could run anything, and leave checks_passed false rather than implying a pass.'),
          '- Commit BY PATHSPEC: `git add <file>` for each file you edited, then `git commit -m "<message>" -- <file> <file>…`',
          '  naming the same files, with the finding id in the message. The index is shared with other patchers in this',
          '  tree; `git commit -- <files>` commits only the paths you name. Never `git add -A`, `git add .` or',
          '  `git commit -a`. Do NOT push.',
          '- If you believe the finding is WRONG, do not quietly skip it and do not "fix" it anyway: return',
          '  status "disputed" with the concrete evidence that refutes it. An unevidenced dispute will be',
          '  treated as a failure.',
        ].join('\n'),
      { label: 'patch:' + f.id, phase: 'Patch', model: CODER, effort: EFFORT, schema: PATCH_SCHEMA }
    ).then((p) => ({ finding: f, patch: p }))
  }

  // A patcher that returned nothing or reported `failed` is logged here; the finding is
  // carried to the orchestrator by collectForOrchestrator either way.
  async function patchGroup(group) {
    const out = []
    for (const item of group.slices) {
      const p = await patchOne(item.finding)
      if (!p) continue
      if (!p.patch || p.patch.status === 'failed') {
        log('patch ' + item.finding.id + ': ' + (p.patch ? 'patcher reported failed' : 'patcher returned nothing'))
      }
      out.push(p)
    }
    return out
  }

  const patched = (await runGroups(patchGroups, WAVE, patchGroup, 'patch wave')).filter(Boolean).flat()

  const done = patched.filter(Boolean)
  rounds.push({ round: round, patched: done, deferred: deferred, handed_off: handedOff })
  log('round ' + round + ': ' + done.filter((p) => p.patch && p.patch.status === 'fixed').length + ' fixed, ' +
    done.filter((p) => p.patch && p.patch.status === 'disputed').length + ' disputed, ' +
    done.filter((p) => !p.patch || p.patch.status === 'failed').length + ' failed')

  phase('Review')
  if (!budgetLeft(40000)) {
    log('stopping before re-review ' + round + ': ' + Math.round(budget.remaining() / 1000) + 'k tokens left in budget — the patches are UNREVIEWED')
    review = null
    reviewMissing = true
    break
  }
  review = stampReview(await callAgent(
    reviewPrompt(
      'review round ' + round + ' of at most ' + MAX_ROUNDS,
      [
        'PATCHES APPLIED SINCE THE LAST REVIEW — the patchers\' own reports; checks_passed is self-reported and',
        'nobody has verified a patch before you. `git show <commit_sha>` each one:',
        JSON.stringify(done.map((p) => ({ finding_id: p.finding.id, claim: p.finding.claim, failure_scenario: p.finding.failure_scenario, patch: p.patch })), null, 2),
        (deferred.length ? 'DEFERRED, NOT PATCHED (already on the orchestrator\'s list; do not re-raise unless a patch made one worse): ' +
          deferred.map((f) => f.id + ' (' + f.claim + ')').join(' | ') : ''),
        (handedOff.length ? 'HANDED TO THE ORCHESTRATOR, NOT PATCHED (below the auto-patch severity; already on their list; do not re-raise unless a patch made one worse): ' +
          handedOff.map((f) => f.id + ' (' + f.claim + ')').join(' | ') : ''),
        '',
        'Two jobs this round, and the second is the one people forget:',
        '(a) Is each patched finding above GENUINELY closed? Read the patch diff: does it close the failure_scenario or',
        '    merely make the symptom go away; does the regression test exercise the scenario, or would it pass on the',
        '    old code? If not closed, raise it again as a finding with `re_raises` set to the earlier id (e.g. "r0:F2")',
        '    so it is not counted twice.',
        '(b) Did the patches themselves introduce anything new? Patch rounds are written under time pressure and',
        '    are a common source of fresh defects. Review their diffs as adversarially as the original work.',
        'A finding the patcher disputed with sound evidence should NOT be re-raised — say so in summary instead; the',
        'dispute is handed to the orchestrator with its evidence regardless.',
        '',
      ].join('\n')
    ),
    { label: 'adversary:r' + round, phase: 'Review', model: JUDGE, effort: EFFORT, schema: REVIEW_SCHEMA }
  ), round)
  reviewMissing = !review
  if (reviewMissing) log('WARNING: re-review ' + round + ' returned nothing after the fallback — the patches are UNREVIEWED')
}

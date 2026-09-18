// ---------------------------------------------------------------------------
// Slice — the plan's tasks become file-disjoint slices.
// ---------------------------------------------------------------------------
phase('Slice')

const PLAN_INDEX = planDoc
  ? 'THE PLAN DOCUMENT: ' + PLAN_PATH + '\nGlobal Constraints at lines ' + (planDoc.global_constraints_lines || '?') +
    '\nTASKS (one slice each unless a chain must be merged):\n' +
    planDoc.tasks.map((t) => '  Task ' + t.n + ' — ' + t.title + ' — files: ' + (t.files || []).join(', ') + ' — lines ' + t.lines).join('\n')
  : (PLAN_PATH ? 'THE PLAN DOCUMENT: ' + PLAN_PATH + ' — read it and index its tasks yourself.' : '')

const plan = await callAgent(
  [
    'You are the SLICER. You do not write the implementation — you map the plan\'s tasks onto slices so that several implementers can work at once without colliding.',
    '',
    'TASK:',
    TASK_TEXT,
    '',
    PLAN_INDEX,
    '',
    'WHAT RECON ALREADY ESTABLISHED — trust this and do not re-derive it:',
    JSON.stringify({
      ecosystem: recon.ecosystem,
      branch: recon.branch,
      base_sha: BASE,
      check_command: CHECK_CMD || null,
      has_executable_checks: HAS_CHECKS,
      other_checks: (recon.verify_commands || []).slice(1),
      layout_notes: recon.layout_notes,
      conventions: recon.conventions,
    }, null, 2),
    '',
    'Do this:',
    '1. Read enough of the repo to plan honestly, building on the recon notes above rather than repeating that work.',
    '   FOLLOW whatever conventions CLAUDE.md / AGENTS.md state.',
    '2. Split the work into at most ' + MAX_SLICES + ' slices. When a plan document is given, ONE TASK = ONE SLICE',
    '   in the plan\'s order, each slice prompt pointing at its task section by path + heading + line range; the',
    '   only reshaping allowed is merging adjacent tasks of a serial chain longer than four.',
    '',
    'The one rule that matters: SLICES MUST BE FILE-DISJOINT. Two slices that touch the same file are run one',
    'after the other instead of at the same time. They each keep their own fresh agent, so the',
    'only thing overlap costs is wall-clock. Declare `files` completely and accurately — under-declaring causes',
    'two agents to edit one file at once, which is the failure mode this whole structure exists to prevent.',
    'Over-declaring costs you time; under-declaring costs you the work.',
    '',
    'Slices that share a file run one after another. If overlap would force MORE THAN FOUR slices into one serial',
    'chain, MERGE adjacent members of that chain into fewer, larger slices (a merged slice still gets one fresh',
    'agent). Every serialised slice pays a fixed cost — a cold agent reading the repo and its spec — so',
    'twelve one-hour-apart micro-slices are slower and dearer than five, and no safer.',
    '',
    'Each slice prompt must be SELF-CONTAINED: its implementer sees only task_summary, shared_context and that',
    'prompt — NOT the full task text. When the task points at a plan or spec document with per-task sections,',
    'give the slice its section as a POINTER (file path + heading + line range) and tell the implementer to read',
    'only that section plus the document\'s global-constraints section, never the whole file. Do not paste the',
    'section into the prompt.',
    'Put anything common (conventions, the check command, where things live, what NOT to touch) in shared_context,',
    'carrying forward the recon notes above so each implementer does not re-read the repo to learn them.',
    'shared_context is also the main cost lever you control. Every implementer starts cold and re-reads the repo',
    'for itself; a fact you establish once here is read once instead of N times. Be generous with it — file',
    'layout, the exact check command, naming conventions, the gotcha that would otherwise cost each agent three',
    'tool calls to rediscover. Terse slices plus a thin shared_context is the expensive shape.',
    '',
    'Slice in whatever unit this repo is actually made of. That is source files for an application, but it may be',
    'modules or environment directories for Terraform, charts for Helm, or migrations for a schema change. What',
    'matters is only that two slices never touch the same file.',
    (HAS_CHECKS
      ? ''
      : '\nThis repo has NOTHING executable to run, so no slice can be proven by running it. Prefer slices whose\n' +
      'correctness is legible in the diff, and note in shared_context that review is the only gate.'),
    '',
    'If some part of the task cannot be sliced or you deliberately left it out, list it in `uncovered`. Do not',
    'silently drop scope — an honest gap is useful, a hidden one is not. `uncovered` is read mechanically: any',
    'entry there makes the run not ok, so it holds ONLY dropped scope — never a caveat, a dependency note or a',
    'sentence saying nothing was dropped. Everything of that kind goes in `notes`.',
    '',
    'Write no code. Make no commits.',
  ].join('\n'),
  { label: 'slice', phase: 'Slice', model: JUDGE, effort: EFFORT, schema: PLAN_SCHEMA }
)

if (!plan || !plan.slices || !plan.slices.length) {
  return { ok: false, stage: 'plan', error: 'planner returned no slices', plan, recon: recon }
}

const SHARED = String(plan.shared_context || '')
// What implementers and patchers see instead of the full task: every agent that carried
// the whole brief re-read it on every turn (plan C: 53 agents, a 4,200-line plan each).
// The adversary keeps the full TASK — it is the bar, and the adversary is the judge.
const TASK_BRIEF = String(plan.task_summary || '').trim() || TASK
// Two-dot: literally "everything added between BASE and HEAD". Three-dot would
// route through merge-base, which is identical while history stays linear and
// quietly different the moment it does not.
const DIFF_CMD = 'git diff ' + BASE + '..HEAD'

if (plan.notes && plan.notes.length) log('planner notes: ' + plan.notes.join(' | '))
if (plan.uncovered && plan.uncovered.length) {
  log('planner left uncovered: ' + plan.uncovered.join(' | '))
}

const groups = groupByFileConflict(plan.slices)
const biggestGroup = groups.reduce((n, g) => Math.max(n, g.slices.length), 0)
// The plan block the cost-gate pause, an out-of-budget stop and the final report carry.
function planReport() {
  return { slices: plan.slices, groups: groups.length, largest_group: biggestGroup, uncovered: plan.uncovered || [], notes: plan.notes || [] }
}
log(plan.slices.length + ' slice(s) -> ' + groups.length + ' conflict-free group(s) (largest holds ' +
  biggestGroup + '), up to ' + WAVE + ' group(s) at a time')
if (groups.length === 1 && plan.slices.length > 2) {
  log('WARNING: all ' + plan.slices.length + ' slices merged into ONE group — their declared files overlap ' +
    'transitively, so nothing can run concurrently. Each slice still gets its own agent; this run ' +
    'will be slow, not large.')
}

// ---------------------------------------------------------------------------
// The cost gate — what the rest of the run would cost at API list prices.
// ---------------------------------------------------------------------------
const spentCounts = {
  probe: PROBE_MODELS ? PRIMARY_MODELS.length : 0,
  recon: 1,
  spec: documents.spec ? 1 : 0,
  doc_review: documents.spec_reviews.filter((r) => r.review).length + documents.plan_reviews.filter((r) => r.review).length +
    [...documents.spec_reviews, ...documents.plan_reviews].filter((r) => r.edit).length,   // an editor lane is priced like a review
  plan_doc: documents.plan && FROM !== 'plan' ? 1 : 0,
  plan_review: documents.plan_reviews.filter((r) => r.review).length,
  answers: (answersFor('spec').length ? 1 : 0) + (answersFor('plan').length ? 1 : 0),
  plan_index: planReindexed ? 1 : 0,
  slice: 1,
}
const nSlices = plan.slices.length
// Measured: the first review raised about one finding per slice; ~60% sat at or above
// "major". The per-round cap and the severity gate bound it from above.
const patchedPerRound = Math.min(MAX_PATCH_PER_ROUND, Math.max(2, Math.round(nSlices * (PATCH_SEVERITY === 'minor' ? 1.0 : PATCH_SEVERITY === 'critical' ? 0.25 : 0.6))))
const aheadCounts = {
  implement: nSlices,
  review: 1 + MAX_ROUNDS,
  patch: MAX_ROUNDS * patchedPerRound,
}
const est = estimateRun(PROFILE, PRICES, spentCounts, aheadCounts)
const estimate = {
  currency: 'USD',
  basis: 'Anthropic first-party API list prices (a non-subscription licence), cached 2026-06-24; per-agent token profile measured over six runs on 2026-09-09..11. Subscription users are not billed per token: this is the size of the run at list prices.',
  prices_per_mtok: PRICES,
  slices: nSlices,
  patch_rounds: MAX_ROUNDS,
  expected_patched_findings_per_round: patchedPerRound,
  spent_so_far_usd: est.spent_usd,
  ahead_usd: est.ahead_usd,
  ahead_low_usd: +(est.ahead_usd * 0.6).toFixed(2),
  ahead_high_usd: +(est.ahead_usd * 1.6).toFixed(2),
  total_expected_usd: +(est.spent_usd + est.ahead_usd).toFixed(2),
  of_which_from_unmeasured_assumptions_usd: est.assumed_usd,
  output_tokens_actually_spent_this_turn: budget.spent(),
  breakdown: est.lines,
  note: 'The low/high band is a fixed 0.6x-1.6x of the expected figure, the rough spread the six measured runs showed; it is not a per-slice-count measurement. A fallback lane (Fable at ~2x Opus) is not in the figure; models.fallbacks.used in the final result says if one ran.',
}
log('COST ESTIMATE at API list prices: ~$' + est.spent_usd + ' spent so far, ~$' + est.ahead_usd +
  ' ahead ($' + estimate.ahead_low_usd + '–$' + estimate.ahead_high_usd + ') for ' + nSlices + ' slice(s), ' +
  MAX_ROUNDS + ' patch round(s); total ~$' + estimate.total_expected_usd)
// maxUsd only ever passes a FINITE total: a broken price table must pause, not wave through.
const withinCeiling = MAX_USD !== null && Number.isFinite(estimate.total_expected_usd) && estimate.total_expected_usd <= MAX_USD
if (!APPROVE_ESTIMATE && !withinCeiling) {
  log('PAUSED at the cost gate — relaunch with approveEstimate:true (or maxUsd) to build')
  return {
    ok: true,
    paused: true,
    stage: 'estimate',
    estimate: estimate,
    how_to_resume: 'Show the user the estimate (expected, the low–high band, what is measured vs assumed) and ask whether to ' +
      'proceed. On yes, relaunch this workflow with the SAME script and resumeFromRunId, and args identical plus ' +
      'approveEstimate:true (or maxUsd:<their ceiling>). Every agent before this gate replays from cache. On no, stop: the ' +
      'documents are committed on the branch and nothing has been implemented.',
    plan: planReport(),
    documents: documentsReport(),
    recon: recon,
  }
}

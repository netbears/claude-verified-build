'use strict'
// Runs the WHOLE engine with the Workflow runtime stubbed: agent() answers from a table
// keyed by label, parallel() behaves like the real one (a thrown thunk becomes null),
// budget has no ceiling. This is the wiring test — every return shape the skill tells
// the orchestrator to read is asserted here, without spending a token.
const test = require('node:test')
const assert = require('node:assert/strict')
const { SRC } = require('./load-helpers')

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const BODY = SRC.replace(/^export const meta = /m, 'const meta = ')
const engine = new AsyncFunction('args', 'agent', 'parallel', 'pipeline', 'log', 'phase', 'budget', BODY)

const SHA = 'a'.repeat(40)
const RECON = {
  is_git_repo: true, head_sha: SHA, branch: 'feat/x', is_trunk: false, dirty: false, ecosystem: 'node/node:test',
  verify_commands: [{ kind: 'test', command: 'node --test', source: 'package.json', verified_runs: true }],
  primary_check_cmd: 'node --test', has_executable_checks: true, today: '2026-09-11', docs_layout: '', conventions: '', layout_notes: '',
}
const SLICES = [
  { id: 's1', title: 'a', prompt: 'do a', files: ['src/a.js'], done_when: 'a' },
  { id: 's2', title: 'b', prompt: 'do b', files: ['src/b.js'], done_when: 'b' },
]

// The default table. A test overrides entries by label (the ':fb-model' suffix is
// stripped before lookup, so a fallback lane answers like its primary unless told).
function table(over) {
  const t = {
    'probe:sonnet': { ok: true },
    'probe:opus': { ok: true },
    recon: RECON,
    spec: { path: 'docs/specs/2026-09-11-x.md', slug: 'x', classification: 'bounded', title: 'x', summary: 's',
      decisions: [{ question: 'q', decision: 'd', why: 'w' }], open_questions: [], commit_sha: 's1' },
    'spec-review:r1': { status: 'issues_found', findings: [{ id: 'F1', severity: 'major', where: 'sec 2', claim: 'wrong', evidence: 'line 3', fix: 'say X' }], summary: 'one' },
    'spec-fold:r1': { folded: ['F1'], refuted: [], commit_sha: 's2', summary: 'folded' },
    'plan-doc': { path: 'docs/plans/2026-09-11-x.md', title: 'x', commit_sha: 'p1', global_constraints_lines: '5-9',
      tasks: [{ n: 1, title: 'a', files: ['src/a.js'], lines: '10-40' }, { n: 2, title: 'b', files: ['src/b.js'], lines: '41-80' }],
      decisions: [{ question: 'order', decision: 'a first', why: 'b consumes a' }] },
    'plan-review:r1': { status: 'approved', findings: [], summary: 'fine' },
    'decision-record': { folded: [], refuted: [], commit_sha: 'd1', summary: 'recorded' },
    // The recorder commits into the plan, so the plan is re-measured on every run that has one.
    'plan-index': { path: 'docs/plans/2026-09-11-x.md', title: 'x', commit_sha: 'd1', global_constraints_lines: '5-9',
      tasks: [{ n: 1, title: 'a', files: ['src/a.js'], lines: '10-40' }, { n: 2, title: 'b', files: ['src/b.js'], lines: '41-80' }] },
    'spec-answers': { folded: [], refuted: [], commit_sha: 'a1', summary: 'answers recorded' },
    'plan-answers': { folded: [], refuted: [], commit_sha: 'a2', summary: 'answers recorded' },
    slice: { shared_context: 'ctx', task_summary: 'brief', slices: SLICES, uncovered: [] },
    'impl:*': (label) => ({ slice_results: [{ id: label.split(':')[1], status: 'done', commit_sha: 'c1', files_touched: [], checks_run: 'node --test', checks_passed: true, notes: '' }] }),
    'adversary:r0': { clean: false, diff_reviewed: true, executed: true, commands_run: 'node --test', output_tail: 'ok', summary: 'two', findings: [
      { id: 'F1', severity: 'major', file: 'src/a.js', claim: 'bug', failure_scenario: 'x -> crash' },
      { id: 'F2', severity: 'minor', file: 'src/b.js', claim: 'nit', failure_scenario: 'y -> wrong' },
    ] },
    'patch:*': (label) => ({ finding_id: label.split(':').slice(1).join(':'), status: 'fixed', commit_sha: 'c9', regression_test: 't', checks_passed: true, notes: '' }),
    'adversary:r1': { clean: true, diff_reviewed: true, executed: true, commands_run: 'node --test', output_tail: 'ok', findings: [], summary: 'clean' },
  }
  return Object.assign(t, over || {})
}

async function run(args, over) {
  const calls = []
  const logs = []
  const t = table(over)
  const agent = async (prompt, opts) => {
    const label = (opts && opts.label) || 'agent'
    const base = label.replace(/:fb-\w+$/, '')
    calls.push({ label, model: opts && opts.model, prompt, opts })
    let hit = Object.prototype.hasOwnProperty.call(t, base) ? t[base] : undefined
    if (hit === undefined) {
      const star = Object.keys(t).find((k) => k.endsWith('*') && base.startsWith(k.slice(0, -1)))
      hit = star ? t[star] : undefined
    }
    if (hit === undefined) throw new Error('no canned answer for ' + label)
    if (typeof hit === 'function') return hit(label, prompt, opts)
    if (hit instanceof Error) throw hit
    return hit
  }
  const parallel = (thunks) => Promise.all(thunks.map((fn) => Promise.resolve().then(fn).catch(() => null)))
  const pipeline = () => { throw new Error('pipeline is not used by the engine') }
  const budget = { total: null, spent: () => 0, remaining: () => Infinity }
  const out = await engine(args, agent, parallel, pipeline, (m) => logs.push(String(m)), () => {}, budget)
  return { out, calls, logs, labels: calls.map((c) => c.label) }
}

const BASE_ARGS = { task: 'Add a slugify helper with tests.' }

test('first launch: probes, recon, the documents, the slicer, then pauses at the cost gate with a finite estimate', async () => {
  const { out, labels } = await run(BASE_ARGS)
  assert.equal(out.paused, true)
  assert.equal(out.stage, 'estimate')
  assert.ok(Number.isFinite(out.estimate.total_expected_usd) && out.estimate.total_expected_usd > 0)
  assert.ok(out.estimate.breakdown['done:probe'])
  assert.deepEqual(labels.slice(0, 3).sort(), ['probe:opus', 'probe:sonnet', 'recon'])
  assert.ok(labels.includes('spec') && labels.includes('spec-review:r1') && labels.includes('spec-fold:r1'))
  assert.ok(labels.includes('plan-doc') && labels.includes('plan-review:r1') && labels.includes('decision-record'))
  assert.equal(labels[labels.length - 1], 'slice')
  assert.ok(!labels.some((l) => l.startsWith('impl:')), 'nothing implemented before approval')
})

test('a plan fold-in with a commit re-measures the plan and keeps the writer\'s decisions', async () => {
  const { out, labels } = await run(BASE_ARGS, {
    'plan-review:r1': { status: 'issues_found', findings: [{ id: 'F1', severity: 'major', where: 'Task 2', claim: 'range off', evidence: 'sed', fix: 'fix' }], summary: 'one' },
    'plan-fold:r1': { folded: ['F1'], refuted: [], commit_sha: 'p2', summary: 'folded' },
    'plan-index': { path: 'docs/plans/2026-09-11-x.md', title: 'x', commit_sha: 'p2', global_constraints_lines: '5-9',
      tasks: [{ n: 1, title: 'a', files: ['src/a.js'], lines: '10-44' }, { n: 2, title: 'b', files: ['src/b.js'], lines: '45-90' }] },
  })
  assert.ok(labels.includes('plan-index'))
  assert.equal(out.documents.plan.tasks[1].lines, '45-90')
  assert.equal(out.documents.plan.decisions.length, 1)
  assert.ok(out.estimate.breakdown['done:plan_index'])
  assert.ok(out.documents.decisions.some((d) => d.stage === 'plan-fold'))
})

test('a partial price override still yields a finite total, and maxUsd passes only a finite total', async () => {
  const a = await run({ ...BASE_ARGS, prices: { sonnet: { in: 3 } } })
  assert.ok(Number.isFinite(a.out.estimate.total_expected_usd))
  const b = await run({ ...BASE_ARGS, prices: { sonnet: { in: 3 } }, maxUsd: 100000 })
  assert.equal(b.out.paused, false, 'a finite total under the ceiling passes the gate')
})

test('approved run: implements, reviews, patches the major, re-reviews clean, hands the minor to the orchestrator', async () => {
  const { out, labels } = await run({ ...BASE_ARGS, approveEstimate: true })
  assert.ok(!labels.some((l) => l.startsWith('verify:')), 'no per-slice or per-patch verifier lane exists: ' + labels.join(','))
  assert.ok(labels.indexOf('adversary:r0') > labels.indexOf('impl:s2'), 'the adversary runs straight after the implementers')
  assert.equal(out.ok, true)
  assert.equal(out.paused, false)
  assert.equal(out.review_missing, false)
  assert.equal(out.final_review.clean, true)
  assert.deepEqual(out.never_ran, [])
  assert.deepEqual(out.not_implemented, [])
  assert.deepEqual(out.lane_errors, [])
  assert.ok(labels.includes('patch:r0:F1'), 'the major is patched under its namespaced id')
  assert.ok(!labels.includes('patch:r0:F2'), 'the minor is not auto-patched')
  assert.deepEqual(out.for_orchestrator.map((f) => f.id), ['r0:F2'])
  assert.match(out.for_orchestrator[0].source, /handed off/)
  assert.equal(out.for_orchestrator_by_severity.minor, 1)
  assert.equal(out.documents.decision_record.commit_sha, 'd1')
  const stages = out.documents.decisions.map((d) => d.stage)
  assert.ok(stages.includes('spec') && stages.includes('spec-fold') && stages.includes('plan'), 'fold-ins are on the record: ' + stages)
  assert.equal(out.documents.decision_record.entries.find((e) => e.stage === 'spec-fold').by, 'engine (spec fold-in author)')
  assert.deepEqual(out.documents.plan.decisions.length, 1, 'the re-measure keeps the plan writer\'s decisions')
  assert.equal(out.models.fallbacks.used.length, 0)
})

test('a probe that returns nothing stops the run before recon', async () => {
  const { out, labels } = await run(BASE_ARGS, { 'probe:opus': null })
  assert.equal(out.ok, false)
  assert.equal(out.stage, 'probe')
  assert.match(out.error, /opus/)
  assert.ok(!labels.includes('recon'))
})

test('a probe that throws is reported the same way, and probeModels:false skips the probe', async () => {
  const { out } = await run(BASE_ARGS, { 'probe:sonnet': new Error('model not permitted') })
  assert.equal(out.stage, 'probe')
  assert.match(out.error, /sonnet/)
  const { labels } = await run({ ...BASE_ARGS, probeModels: false })
  assert.ok(!labels.some((l) => l.startsWith('probe:')))
  assert.equal(labels[0], 'recon')
})

test('recon gates: dirty tree and trunk stop the run with stage recon', async () => {
  const d = await run(BASE_ARGS, { recon: { ...RECON, dirty: true, dirty_summary: ' M a.js' } })
  assert.equal(d.out.ok, false); assert.equal(d.out.stage, 'recon'); assert.match(d.out.error, /dirty/)
  const t = await run(BASE_ARGS, { recon: { ...RECON, is_trunk: true, branch: 'main' } })
  assert.equal(t.out.stage, 'recon'); assert.match(t.out.error, /trunk/)
  const g = await run({ ...BASE_ARGS, allowDirty: true, allowTrunk: true }, { recon: { ...RECON, dirty: true, is_trunk: true } })
  assert.equal(g.out.paused, true)
})

test('an owner question pauses the spec stage; the resume records the answer and reaches the cost gate', async () => {
  const withQ = { spec: { ...table().spec, open_questions: [{ id: 'Q1', question: 'Delete old rows?', options: [
    { label: 'yes', consequence: 'data gone' }, { label: 'no', consequence: 'kept' }], recommended: 'no', why: 'reversible' }] } }
  const p = await run(BASE_ARGS, withQ)
  assert.equal(p.out.paused, true)
  assert.equal(p.out.stage, 'spec')
  assert.deepEqual(p.out.questions.map((q) => q.id), ['spec:Q1'])
  assert.ok(!p.labels.includes('plan-doc'))
  const r = await run({ ...BASE_ARGS, answers: [{ id: 'spec:Q1', answer: 'yes' }] }, withQ)
  assert.equal(r.out.stage, 'estimate')
  assert.ok(r.labels.includes('spec-answers'))
  const planPrompt = r.calls.find((c) => c.label === 'plan-doc').prompt
  assert.match(planPrompt, /OWNER'S ANSWERS/)
  assert.equal(r.out.documents.decisions.find((d) => d.why === "the owner's answer").decision, 'yes')
  const auto = await run({ ...BASE_ARGS, pauseForOwner: false }, withQ)
  assert.equal(auto.out.stage, 'estimate')
  assert.match(auto.out.documents.decisions.find((d) => d.stage === 'spec' && /owner not asked/.test(d.decision)).decision, /^no/)
})

test('the answers prompt is byte-identical whatever order the orchestrator passes the answers in', async () => {
  const withQ = { spec: { ...table().spec, open_questions: [
    { id: 'Q1', question: 'a?', options: [{ label: 'x', consequence: 'c' }, { label: 'y', consequence: 'd' }], recommended: 'x', why: 'w' },
    { id: 'Q2', question: 'b?', options: [{ label: 'x', consequence: 'c' }, { label: 'y', consequence: 'd' }], recommended: 'x', why: 'w' },
  ] } }
  const a = await run({ ...BASE_ARGS, answers: [{ id: 'spec:Q1', answer: 'x' }, { id: 'spec:Q2', answer: 'y' }] }, withQ)
  const b = await run({ ...BASE_ARGS, answers: [{ id: 'spec:Q2', answer: 'y' }, { id: 'spec:Q1', answer: 'x' }] }, withQ)
  assert.equal(a.calls.find((c) => c.label === 'spec-answers').prompt, b.calls.find((c) => c.label === 'spec-answers').prompt)
})

test('slices keep the plan order inside a chain and the bridging slice runs last', async () => {
  const three = [...SLICES, { id: 's3', title: 'c', prompt: 'do c', files: ['src/a.js', 'src/b.js'], done_when: 'c' }]
  const { labels } = await run({ ...BASE_ARGS, approveEstimate: true }, { slice: { shared_context: 'ctx', task_summary: 'brief', slices: three, uncovered: [] } })
  assert.deepEqual(labels.filter((l) => l.startsWith('impl:')), ['impl:s1', 'impl:s2', 'impl:s3'])
})

test('an implementer that throws is a recorded lane error, not a dropped group, and the run still reports', async () => {
  const { out, labels } = await run({ ...BASE_ARGS, approveEstimate: true, fallback: false }, { 'impl:s2': new Error('budget exhausted') })
  assert.equal(out.ok, false, 'a slice nobody implemented is not a successful run')
  assert.deepEqual(out.not_implemented, ['s2'])
  assert.deepEqual(out.never_ran, [])
  assert.equal(out.lane_errors.length, 1)
  assert.match(out.lane_errors[0].error, /budget/)
  assert.ok(labels.includes('adversary:r0'), 'the adversary still reviews what did land')
})

test('a fallback lane is recorded and its label carries the tier', async () => {
  const { out, labels } = await run({ ...BASE_ARGS, approveEstimate: true }, { 'adversary:r0': (label) => (label.endsWith(':fb-fable') ? table()['adversary:r0'] : null) })
  assert.equal(out.ok, true)
  assert.ok(labels.includes('adversary:r0:fb-fable'))
  assert.deepEqual(out.models.fallbacks.used, [{ label: 'adversary:r0', primary: 'opus', fallback: 'fable' }])
  assert.equal(out.lane_errors.length, 1)
})

test('an adversary that returns nothing after its fallback makes the run ok:false and unreviewed', async () => {
  const { out } = await run({ ...BASE_ARGS, approveEstimate: true }, { 'adversary:r0': null })
  assert.equal(out.ok, false)
  assert.equal(out.review_missing, true)
  assert.equal(out.stage, 'review')
  assert.equal(out.final_review, null)
})

test('a re-review that returns nothing carries every patched finding to the orchestrator', async () => {
  const { out } = await run({ ...BASE_ARGS, approveEstimate: true }, { 'adversary:r1': null })
  assert.equal(out.ok, false)
  assert.equal(out.review_missing, true)
  assert.deepEqual(out.for_orchestrator.map((f) => f.id).sort(), ['r0:F1', 'r0:F2'])
  assert.match(out.for_orchestrator.find((f) => f.id === 'r0:F1').source, /no final review/)
})

test('a failed, disputed or re-raised patch is carried to the orchestrator; a re-raise is not counted twice', async () => {
  const findings = [
    { id: 'F1', severity: 'major', file: 'src/a.js', claim: 'one', failure_scenario: 'x' },
    { id: 'F2', severity: 'major', file: 'src/b.js', claim: 'two', failure_scenario: 'x' },
    { id: 'F3', severity: 'critical', file: 'src/c.js', claim: 'three', failure_scenario: 'x' },
  ]
  const { out, calls } = await run({ ...BASE_ARGS, approveEstimate: true }, {
    'adversary:r0': { clean: false, diff_reviewed: true, executed: true, summary: 's', findings },
    'patch:r0:F1': { finding_id: 'r0:F1', status: 'failed', notes: 'could not' },
    'patch:r0:F2': { finding_id: 'r0:F2', status: 'disputed', notes: 'evidence here' },
    'patch:r0:F3': { finding_id: 'r0:F3', status: 'fixed', commit_sha: 'c9', regression_test: 't', checks_passed: true, notes: '' },
    'adversary:r1': { clean: false, diff_reviewed: true, executed: true, summary: 's', findings: [
      { id: 'F1', severity: 'critical', file: 'src/c.js', claim: 'three, still', failure_scenario: 'x', re_raises: 'r0:F3' }] },
  })
  const rePrompt = calls.find((c) => c.label === 'adversary:r1').prompt
  assert.match(rePrompt, /"finding_id": "r0:F3"/, 'the re-review is handed the patch report to judge')
  assert.match(rePrompt, /evidence here/, 'and the dispute, with its evidence')
  const byId = Object.fromEntries(out.for_orchestrator.map((f) => [f.id, f.source]))
  assert.deepEqual(Object.keys(byId).sort(), ['r0:F1', 'r0:F2', 'r1:F1'])
  assert.match(byId['r0:F1'], /patch failed/)
  assert.match(byId['r0:F2'], /disputed/)
  assert.equal(byId['r1:F1'], 'final review')
  assert.equal(out.for_orchestrator[0].severity, 'critical')
  assert.equal(out.stopped_at_round_cap, true)
})

test('from:spec with a path: the spec is not rewritten, and every judge is told to read the document', async () => {
  const { out, calls, labels } = await run({ task: 'docs/specs/2026-09-11-x.md', from: 'spec', approveEstimate: true })
  assert.equal(out.ok, true)
  assert.ok(!labels.includes('spec') && !labels.includes('spec-review:r1'))
  assert.ok(labels.includes('plan-doc'))
  for (const l of ['recon', 'slice', 'adversary:r0']) {
    assert.match(calls.find((c) => c.label === l).prompt, /Read it whole/, l + ' is told to read the path')
  }
  assert.equal(out.documents.spec_path, 'docs/specs/2026-09-11-x.md')
})

test('from:plan: no documents, no record, straight to the slicer', async () => {
  const { out, labels } = await run({ task: 'docs/plans/2026-09-11-x.md', from: 'plan' })
  assert.equal(out.stage, 'estimate')
  assert.deepEqual(labels.filter((l) => !l.startsWith('probe:')), ['recon', 'slice'])
  assert.equal(out.documents.decision_record, undefined)
})

test('the token budget stops the run between phases with a report instead of a wall of nulls', async () => {
  const calls = []
  const agent = async (prompt, opts) => {
    calls.push(opts.label)
    const t = table()
    const base = opts.label.replace(/:fb-\w+$/, '')
    const hit = t[base] || t[Object.keys(t).find((k) => k.endsWith('*') && base.startsWith(k.slice(0, -1)))]
    return typeof hit === 'function' ? hit(opts.label) : hit
  }
  const parallel = (thunks) => Promise.all(thunks.map((fn) => Promise.resolve().then(fn).catch(() => null)))
  let spent = 0
  const budget = { total: 100000, spent: () => spent, remaining: () => Math.max(0, 100000 - spent) }
  const wrapped = async (p, o) => { const r = await agent(p, o); if (o.label === 'slice') spent = 90000; return r }
  const out = await engine({ ...BASE_ARGS, approveEstimate: true }, wrapped, parallel, () => {}, () => {}, () => {}, budget)
  assert.equal(out.ok, false)
  assert.equal(out.stage, 'implement')
  assert.match(out.error, /budget/)
  assert.ok(!calls.some((l) => l.startsWith('impl:')))
})

test('the implementer is told to stage by name and never sweep the shared tree', async () => {
  const { calls } = await run({ ...BASE_ARGS, approveEstimate: true })
  const impl = calls.find((c) => c.label === 'impl:s1').prompt
  assert.match(impl, /git add <file>/)
  assert.match(impl, /never `git add -A`/i)
})

// ---------------------------------------------------------------------------
// The verdict is mechanical. ok:true means the run completed AND every gate
// passed; anything else names its reasons in `not_ok`.
// ---------------------------------------------------------------------------
test('a slice with no implementer result makes the run not ok, and not_ok names it', async () => {
  const { out } = await run({ ...BASE_ARGS, approveEstimate: true, fallback: false }, { 'impl:s2': new Error('budget exhausted') })
  assert.equal(out.ok, false)
  assert.deepEqual(out.not_implemented, ['s2'])
  assert.ok(out.not_ok.some((r) => /not implemented/.test(r)), out.not_ok.join(' | '))
})

test('the adversary is told to run the check itself and is handed the implementers\' reports as claims', async () => {
  const { calls, out } = await run({ ...BASE_ARGS, approveEstimate: true })
  const p = calls.find((c) => c.label === 'adversary:r0').prompt
  assert.match(p, /RUN THE CHECK YOURSELF/)
  assert.match(p, /node --test/)
  assert.match(p, /WHAT THE IMPLEMENTERS CLAIM/)
  assert.match(p, /"slice": "s1"/)
  assert.match(p, /TODO stubs/, 'the old verifier hunt list travels with the adversary')
  assert.deepEqual(out.implementation.map((r) => r.slice), ['s1', 's2'])
  assert.equal(out.implementation[0].impl.slice_results[0].status, 'done')
})

test('a final review that did not run the check cannot make the run ok when the repo has checks', async () => {
  const { out } = await run({ ...BASE_ARGS, approveEstimate: true }, {
    'adversary:r1': { clean: true, diff_reviewed: true, executed: false, findings: [], summary: 'read it' },
  })
  assert.equal(out.ok, false)
  assert.equal(out.final_review.clean, false)
  assert.equal(out.final_review.claimed_clean, true)
  assert.ok(out.not_ok.some((r) => /did not run the check/.test(r)), out.not_ok.join(' | '))
})

test('a first review with no findings but executed:false is not clean, so nothing is patched and the run is not ok', async () => {
  const { out, labels } = await run({ ...BASE_ARGS, approveEstimate: true }, {
    'adversary:r0': { clean: true, diff_reviewed: true, executed: false, findings: [], summary: 'skimmed' },
  })
  assert.ok(!labels.some((l) => l.startsWith('patch:')))
  assert.equal(out.final_review.clean, false)
  assert.equal(out.ok, false)
})

test('without executable checks a review that read the diff and found nothing is clean', async () => {
  const { out, calls } = await run({ ...BASE_ARGS, approveEstimate: true }, {
    recon: { ...RECON, verify_commands: [], primary_check_cmd: '', has_executable_checks: false },
    'adversary:r0': { clean: true, diff_reviewed: true, executed: false, checks_available: false, findings: [], summary: 'read only' },
  })
  assert.equal(out.repo.executable_checks, false)
  assert.equal(out.final_review.clean, true)
  assert.equal(out.ok, true)
  assert.match(calls.find((c) => c.label === 'adversary:r0').prompt, /nothing executable/i)
})

test('a review that says clean:true but lists findings is not clean: the findings are patched and reported', async () => {
  const { out, labels } = await run({ ...BASE_ARGS, approveEstimate: true }, {
    'adversary:r0': { clean: true, diff_reviewed: true, executed: true, summary: 'clean?', findings: [
      { id: 'F1', severity: 'critical', file: 'src/a.js', claim: 'bug', failure_scenario: 'x -> crash' }] },
  })
  assert.ok(labels.includes('patch:r0:F1'), 'the critical finding was patched despite clean:true')
  assert.equal(out.patch_rounds.length, 1)
})

test('a review that did not read the diff cannot make the run ok', async () => {
  const { out } = await run({ ...BASE_ARGS, approveEstimate: true }, {
    'adversary:r1': { clean: true, diff_reviewed: false, executed: true, findings: [], summary: 'skimmed' },
  })
  assert.equal(out.ok, false)
  assert.equal(out.final_review.clean, false)
  assert.ok(out.not_ok.some((r) => /diff/.test(r)), out.not_ok.join(' | '))
})

test('scope the slicer left uncovered makes the run not ok', async () => {
  const { out } = await run({ ...BASE_ARGS, approveEstimate: true }, { slice: { shared_context: 'ctx', task_summary: 'brief', slices: SLICES, uncovered: ['the docs'] } })
  assert.equal(out.ok, false)
  assert.ok(out.not_ok.some((r) => /uncovered/.test(r)), out.not_ok.join(' | '))
})

test('uncommitted changes in the tree at review time make the run not ok', async () => {
  const { out } = await run({ ...BASE_ARGS, approveEstimate: true }, {
    'adversary:r0': { clean: true, diff_reviewed: true, executed: true, findings: [], summary: 'clean', dirty_paths: ' M src/a.js' },
  })
  assert.equal(out.ok, false)
  assert.equal(out.uncommitted_at_review, ' M src/a.js')
  assert.ok(out.not_ok.some((r) => /uncommitted/.test(r)), out.not_ok.join(' | '))
})

test('a clean, complete run is ok with no reasons against it', async () => {
  const { out } = await run({ ...BASE_ARGS, approveEstimate: true })
  assert.equal(out.ok, true)
  assert.deepEqual(out.not_ok, [])
})

// ---------------------------------------------------------------------------
// The shared tree: what the prompts must say, and what runs beside what.
// ---------------------------------------------------------------------------
test('implementers and patchers commit by pathspec, so a sibling\'s staged file is never swept into their commit', async () => {
  const { calls } = await run({ ...BASE_ARGS, approveEstimate: true })
  for (const label of ['impl:s1', 'patch:r0:F1']) {
    const p = calls.find((c) => c.label === label).prompt
    assert.match(p, /git commit -m "<message>" -- <file>/, label)
    assert.match(p, /never `git add -A`/i, label)
  }
})

// Tracks, per agent label, how many implement/patch agents were live when it started.
function concurrencyTable(over) {
  const live = new Set()
  const liveAt = {}
  const t = table(over)
  const wrap = (key) => {
    const base = t[key]
    t[key] = async (label, prompt, opts) => {
      liveAt[label] = [...live]
      live.add(label)
      await new Promise((r) => setImmediate(r))
      live.delete(label)
      return typeof base === 'function' ? base(label, prompt, opts) : base
    }
  }
  wrap('impl:*'); wrap('patch:*')
  return { t, liveAt }
}

test('a slice with no declared files runs with nothing else live, after the grouped slices', async () => {
  const three = [{ id: 's0', title: 'z', prompt: 'do z', files: [], done_when: 'z' }, ...SLICES]
  const { t, liveAt } = concurrencyTable({ slice: { shared_context: 'ctx', task_summary: 'brief', slices: three, uncovered: [] } })
  const { labels } = await run({ ...BASE_ARGS, approveEstimate: true }, t)
  assert.deepEqual(liveAt['impl:s0'], [], 's0 started with no other implementer live: ' + JSON.stringify(liveAt))
  assert.ok(labels.indexOf('impl:s0') > labels.indexOf('impl:s2'), 'the exclusive slice runs after the grouped ones')
  assert.ok(liveAt['impl:s2'].includes('impl:s1'), 'the disjoint slices still run beside each other')
})

test('a file touched outside the declared set that another group declared is a violation and a reason against the run', async () => {
  const { out } = await run({ ...BASE_ARGS, approveEstimate: true }, {
    'impl:s1': { slice_results: [{ id: 's1', status: 'done', commit_sha: 'c1', files_touched: ['src/a.js', 'src/b.js'], checks_run: 'node --test', checks_passed: true, notes: 'had to' }] },
  })
  assert.deepEqual(out.footprint_violations, [{ slice: 's1', file: 'src/b.js', collides_with: ['s2'] }])
  assert.equal(out.ok, false)
  assert.ok(out.not_ok.some((r) => /undeclared/.test(r)), out.not_ok.join(' | '))
})

test('two findings that share a test file are patched one after the other, and a finding with no file runs alone', async () => {
  const findings = [
    { id: 'F1', severity: 'major', file: 'src/a.js', files: ['src/a.js', 'test/shared.test.js'], claim: 'one', failure_scenario: 'x' },
    { id: 'F2', severity: 'major', file: 'src/b.js', files: ['src/b.js', 'test/shared.test.js'], claim: 'two', failure_scenario: 'x' },
    { id: 'F3', severity: 'major', claim: 'three', failure_scenario: 'x' },
    { id: 'F4', severity: 'major', file: 'src/d.js', claim: 'four', failure_scenario: 'x' },
  ]
  const { t, liveAt } = concurrencyTable({ 'adversary:r0': { clean: false, diff_reviewed: true, executed: true, summary: 's', findings } })
  await run({ ...BASE_ARGS, approveEstimate: true }, t)
  assert.ok(!liveAt['patch:r0:F2'].includes('patch:r0:F1'), 'F2 waited for F1 (shared test file)')
  assert.deepEqual(liveAt['patch:r0:F3'].filter((l) => l.startsWith('patch:')), [], 'F3 (no file) ran with no patcher live')
  assert.ok(liveAt['patch:r0:F4'].includes('patch:r0:F1') || liveAt['patch:r0:F1'].includes('patch:r0:F4'), 'F4 ran beside the F1 group')
})

// ---------------------------------------------------------------------------
// The front half: questions are never dropped, and a lost document lane stops the run.
// ---------------------------------------------------------------------------
test('a spec writer\'s Q1 and a reviewer\'s Q1 are both asked', async () => {
  const q = (question) => ({ id: 'Q1', question, options: [{ label: 'a', consequence: 'c' }, { label: 'b', consequence: 'd' }], recommended: 'a', why: 'w' })
  const { out } = await run(BASE_ARGS, {
    spec: { ...table().spec, open_questions: [q('Delete old rows?')] },
    'spec-review:r1': { status: 'approved', findings: [], summary: 'fine', questions_for_owner: [q('Charge the card?')] },
  })
  assert.equal(out.paused, true)
  assert.deepEqual(out.questions.map((x) => x.question), ['Delete old rows?', 'Charge the card?'])
})

test('the plan writer can escalate an owner question, and the run pauses at the plan stage', async () => {
  const { out, calls } = await run(BASE_ARGS, {
    'plan-doc': { ...table()['plan-doc'], open_questions: [{ id: 'Q1', question: 'Drop the column now or in a later migration?', options: [
      { label: 'now', consequence: 'data gone' }, { label: 'later', consequence: 'kept' }], recommended: 'later', why: 'reversible' }] },
  })
  assert.equal(out.paused, true)
  assert.equal(out.stage, 'plan')
  assert.deepEqual(out.questions.map((q) => q.id), ['plan:Q1'])
  assert.match(calls.find((c) => c.label === 'plan-doc').prompt, /open_questions/)
})

test('an answers author that returns nothing stops the run: the owner\'s decision is not claimed as recorded', async () => {
  const withQ = { spec: { ...table().spec, open_questions: [{ id: 'Q1', question: 'Delete old rows?', options: [
    { label: 'yes', consequence: 'data gone' }, { label: 'no', consequence: 'kept' }], recommended: 'no', why: 'reversible' }] }, 'spec-answers': null }
  const { out, labels } = await run({ ...BASE_ARGS, answers: [{ id: 'spec:Q1', answer: 'yes' }] }, withQ)
  assert.equal(out.ok, false)
  assert.equal(out.stage, 'spec')
  assert.match(out.error, /answer/)
  assert.ok(!labels.includes('plan-doc'))
  assert.ok(!out.documents.decisions.some((d) => d.why === "the owner's answer"))
})

test('a document reviewer or fold-in that returns nothing stops the run before anything is sliced', async () => {
  const a = await run(BASE_ARGS, { 'spec-review:r1': null })
  assert.equal(a.out.ok, false); assert.equal(a.out.stage, 'spec-review'); assert.ok(!a.labels.includes('slice'))
  const b = await run(BASE_ARGS, { 'spec-fold:r1': null })
  assert.equal(b.out.ok, false); assert.equal(b.out.stage, 'spec-review'); assert.ok(!b.labels.includes('plan-doc'))
  const c = await run(BASE_ARGS, { 'plan-review:r1': null })
  assert.equal(c.out.ok, false); assert.equal(c.out.stage, 'plan-review'); assert.ok(!c.labels.includes('slice'))
})

test('a recorder that returns nothing stops the run: no code is built on an uncommitted decision record', async () => {
  const { out, labels } = await run({ ...BASE_ARGS, approveEstimate: true }, { 'decision-record': null })
  assert.equal(out.ok, false)
  assert.equal(out.stage, 'record')
  assert.ok(!labels.includes('slice'))
  assert.equal(out.documents.decision_record.commit_sha, null)
})

test('the plan is re-measured after the recorder commits into it, so slice pointers are current', async () => {
  const { labels, out } = await run(BASE_ARGS, {
    'plan-index': { path: 'docs/plans/2026-09-11-x.md', title: 'x', commit_sha: 'd1', global_constraints_lines: '5-9',
      tasks: [{ n: 1, title: 'a', files: ['src/a.js'], lines: '10-40' }, { n: 2, title: 'b', files: ['src/b.js'], lines: '41-80' }] },
  })
  assert.ok(labels.indexOf('plan-index') > labels.indexOf('decision-record'), 'measured after the recorder: ' + labels.join(','))
  assert.equal(labels.filter((l) => l === 'plan-index').length, 1, 'one measurement per run, after every commit into the plan')
  assert.equal(out.documents.plan.commit_sha, 'd1')
  assert.equal(out.documents.plan.decisions.length, 1)
})

// ---------------------------------------------------------------------------
// The check command, and the patch round's own ordering.
// ---------------------------------------------------------------------------
test('an explicit testCmd wins even when recon found nothing executable', async () => {
  const { out, calls } = await run({ ...BASE_ARGS, approveEstimate: true, testCmd: 'make check' },
    { recon: { ...RECON, verify_commands: [], primary_check_cmd: '', has_executable_checks: false } })
  assert.equal(out.repo.executable_checks, true)
  assert.equal(out.repo.check_command, 'make check')
  assert.match(calls.find((c) => c.label === 'adversary:r0').prompt, /RUN THE CHECK YOURSELF\. The command that proves this repo still works is: make check/)
})

test('within a patch group the next patcher starts only after the previous one finished, and the re-review follows the whole round', async () => {
  const findings = [
    { id: 'F1', severity: 'major', file: 'src/a.js', claim: 'one', failure_scenario: 'x' },
    { id: 'F2', severity: 'major', file: 'src/a.js', claim: 'two', failure_scenario: 'x' },
  ]
  const { t, liveAt } = concurrencyTable({ 'adversary:r0': { clean: false, diff_reviewed: true, executed: true, summary: 's', findings } })
  const { labels } = await run({ ...BASE_ARGS, approveEstimate: true }, t)
  assert.ok(!liveAt['patch:r0:F2'].includes('patch:r0:F1'), 'F2 started while F1 was still editing the same file')
  assert.ok(labels.indexOf('adversary:r1') > labels.indexOf('patch:r0:F2'), 'the re-review runs after the last patcher')
  assert.ok(!labels.some((l) => l.startsWith('verify:')), 'no patch verifier lane')
})

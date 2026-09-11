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
    slice: { shared_context: 'ctx', task_summary: 'brief', slices: SLICES, uncovered: [] },
    'impl:*': (label) => ({ slice_results: [{ id: label.split(':')[1], status: 'done', commit_sha: 'c1', files_touched: [], checks_run: 'node --test', checks_passed: true, notes: '' }] }),
    'verify:*': { verified: true, executed: true, commands_run: 'node --test', output_tail: 'ok', checks_available: true, problems: [], summary: 'ok' },
    'adversary:r0': { clean: false, diff_reviewed: true, summary: 'two', findings: [
      { id: 'F1', severity: 'major', file: 'src/a.js', claim: 'bug', failure_scenario: 'x -> crash' },
      { id: 'F2', severity: 'minor', file: 'src/b.js', claim: 'nit', failure_scenario: 'y -> wrong' },
    ] },
    'patch:*': (label) => ({ finding_id: label.split(':').slice(1).join(':'), status: 'fixed', commit_sha: 'c9', regression_test: 't', checks_passed: true, notes: '' }),
    'adversary:r1': { clean: true, diff_reviewed: true, findings: [], summary: 'clean' },
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
  assert.ok(!labels.includes('plan-index'), 'an approved plan is not re-measured')
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

test('approved run: implements, verifies, reviews, patches the major, re-reviews clean, hands the minor to the orchestrator', async () => {
  const { out, labels } = await run({ ...BASE_ARGS, approveEstimate: true })
  assert.equal(out.ok, true)
  assert.equal(out.paused, false)
  assert.equal(out.review_missing, false)
  assert.equal(out.final_review.clean, true)
  assert.deepEqual(out.never_ran, [])
  assert.deepEqual(out.not_implemented, [])
  assert.deepEqual(out.lane_errors, [])
  assert.ok(labels.includes('patch:r0:F1'), 'the major is patched under its namespaced id')
  assert.ok(labels.includes('verify:r0:F1'))
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
  assert.ok(labels.includes('verify:s2'), 'the verifier still runs and will fail the slice')
})

test('a fallback lane is recorded and its label carries the tier', async () => {
  const { out, labels } = await run({ ...BASE_ARGS, approveEstimate: true }, { 'verify:s1': (label) => (label.endsWith(':fb-fable') ? table()['verify:*'] : null) })
  assert.equal(out.ok, true)
  assert.ok(labels.includes('verify:s1:fb-fable'))
  assert.deepEqual(out.models.fallbacks.used, [{ label: 'verify:s1', primary: 'opus', fallback: 'fable' }])
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

test('a failed, disputed or unverified patch is carried to the orchestrator; a re-raise is not counted twice', async () => {
  const findings = [
    { id: 'F1', severity: 'major', file: 'src/a.js', claim: 'one', failure_scenario: 'x' },
    { id: 'F2', severity: 'major', file: 'src/b.js', claim: 'two', failure_scenario: 'x' },
    { id: 'F3', severity: 'critical', file: 'src/c.js', claim: 'three', failure_scenario: 'x' },
  ]
  const { out, labels } = await run({ ...BASE_ARGS, approveEstimate: true }, {
    'adversary:r0': { clean: false, diff_reviewed: true, summary: 's', findings },
    'patch:r0:F1': { finding_id: 'r0:F1', status: 'failed', notes: 'could not' },
    'patch:r0:F2': { finding_id: 'r0:F2', status: 'disputed', notes: 'evidence here' },
    'patch:r0:F3': { finding_id: 'r0:F3', status: 'fixed', commit_sha: 'c9', regression_test: 't', checks_passed: true, notes: '' },
    'verify:r0:F3': { verified: false, executed: true, commands_run: 'x', output_tail: 'FAIL', checks_available: true, problems: [{ severity: 'major', what: 'no', evidence: 'e' }], summary: 'no' },
    'adversary:r1': { clean: false, diff_reviewed: true, summary: 's', findings: [
      { id: 'F1', severity: 'critical', file: 'src/c.js', claim: 'three, still', failure_scenario: 'x', re_raises: 'r0:F3' }] },
  })
  assert.ok(!labels.includes('verify:r0:F1'), 'a failed patch gets no verifier')
  assert.ok(labels.includes('verify:r0:F2'), 'a dispute is judged')
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
  for (const l of ['recon', 'slice', 'verify:s1', 'adversary:r0']) {
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
  assert.match(impl, /never `git add -A`/)
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

test('a slice that failed verification makes the run not ok', async () => {
  const { out } = await run({ ...BASE_ARGS, approveEstimate: true }, {
    'verify:s1': { verified: false, executed: true, commands_run: 'node --test', output_tail: 'FAIL', checks_available: true, problems: [{ severity: 'major', what: 'x', evidence: 'e' }], summary: 'no' },
  })
  assert.equal(out.ok, false)
  assert.deepEqual(out.failed_verification, ['s1'])
  assert.ok(out.not_ok.some((r) => /failed verification/.test(r)), out.not_ok.join(' | '))
})

test('verified:true without executed:true is not a verification when the repo has checks', async () => {
  const { out } = await run({ ...BASE_ARGS, approveEstimate: true }, {
    'verify:s1': { verified: true, executed: false, commands_run: '', output_tail: '', checks_available: true, problems: [], summary: 'read it' },
  })
  assert.deepEqual(out.failed_verification, ['s1'])
  assert.equal(out.implementation.find((r) => r.slice === 's1').verified, false)
  assert.ok(out.implementation.find((r) => r.slice === 's1').problems.some((p) => /not executed/.test(p.what)))
})

test('a review that says clean:true but lists findings is not clean: the findings are patched and reported', async () => {
  const { out, labels } = await run({ ...BASE_ARGS, approveEstimate: true }, {
    'adversary:r0': { clean: true, diff_reviewed: true, summary: 'clean?', findings: [
      { id: 'F1', severity: 'critical', file: 'src/a.js', claim: 'bug', failure_scenario: 'x -> crash' }] },
  })
  assert.ok(labels.includes('patch:r0:F1'), 'the critical finding was patched despite clean:true')
  assert.equal(out.patch_rounds.length, 1)
})

test('a review that did not read the diff cannot make the run ok', async () => {
  const { out } = await run({ ...BASE_ARGS, approveEstimate: true }, {
    'adversary:r1': { clean: true, diff_reviewed: false, findings: [], summary: 'skimmed' },
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
    'adversary:r0': { clean: true, diff_reviewed: true, findings: [], summary: 'clean', dirty_paths: ' M src/a.js' },
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

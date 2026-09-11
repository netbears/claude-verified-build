'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { loadHelpers } = require('./load-helpers')

const H = loadHelpers([
  'normPath', 'expandBraces', 'pathsOverlap', 'declaredFiles', 'groupByFileConflict',
  'severityRank', 'mergePrices', 'priceOf', 'lineCost', 'estimateRun',
  'namespaced', 'parseAnswers', 'collectForOrchestrator', 'looksLikePath',
  'footprintViolations', 'patchFootprint',
], { consts: ['DEFAULT_PRICES', 'RECON_SCHEMA'] })

test('recon must report today as a YYYY-MM-DD date: required, with a pattern the runtime enforces', () => {
  assert.ok(H.RECON_SCHEMA.required.includes('today'))
  const re = new RegExp(H.RECON_SCHEMA.properties.today.pattern)
  assert.ok(re.test('2026-09-11'))
  assert.ok(!re.test('11 Sep 2026') && !re.test(''))
})

const ids = (groups) => groups.map((g) => g.slices.map((s) => s.id).join('>'))

test('normPath collapses separators, ./ and .. segments', () => {
  assert.equal(H.normPath('./src/a.py'), 'src/a.py')
  assert.equal(H.normPath('src\\a.py'), 'src/a.py')
  assert.equal(H.normPath('.//src/./a.py/'), 'src/a.py')
  assert.equal(H.normPath('/src/a.py'), 'src/a.py')
  assert.equal(H.normPath('src/../src/a.py'), 'src/a.py')
  assert.equal(H.normPath('a/b/../../c.py'), 'c.py')
})

test('expandBraces expands one and two brace groups', () => {
  assert.deepEqual(H.expandBraces('src/{a,b}.py'), ['src/a.py', 'src/b.py'])
  assert.deepEqual(H.expandBraces('src/{a,b}/{c,d}.py'), ['src/a/c.py', 'src/a/d.py', 'src/b/c.py', 'src/b/d.py'])
  assert.deepEqual(H.expandBraces('plain.py'), ['plain.py'])
})

test('pathsOverlap: equal, directory prefix, glob, and disjoint', () => {
  assert.equal(H.pathsOverlap('src/a.py', 'src/a.py'), true)
  assert.equal(H.pathsOverlap('modules/vpc', 'modules/vpc/main.tf'), true)
  assert.equal(H.pathsOverlap('modules/vpc/main.tf', 'modules/vpc'), true)
  assert.equal(H.pathsOverlap('modules/vpc', 'modules/vpc2/main.tf'), false)
  assert.equal(H.pathsOverlap('src/*.py', 'src/a.py'), true)
  assert.equal(H.pathsOverlap('src/**/*.py', 'src/deep/a.py'), true)
  assert.equal(H.pathsOverlap('src/*.py', 'lib/a.py'), false)
  assert.equal(H.pathsOverlap('src/a.py', 'src/b.py'), false)
})

test('a slice that bridges two groups keeps the plan order', () => {
  const g = H.groupByFileConflict([
    { id: 's1', files: ['a.py'] }, { id: 's2', files: ['b.py'] }, { id: 's3', files: ['a.py', 'b.py'] },
  ])
  assert.deepEqual(ids(g), ['s1>s2>s3'])
})

test('groups stay in first-appearance order and disjoint slices stay apart', () => {
  const g = H.groupByFileConflict([
    { id: 's1', files: ['a.py'] }, { id: 's2', files: ['b.py'] }, { id: 's3', files: ['c.py'] }, { id: 's4', files: ['a.py'] },
  ])
  assert.deepEqual(ids(g), ['s1>s4', 's2', 's3'])
})

test('a directory, a glob and a dot-dot path collide with the files they cover', () => {
  assert.equal(H.groupByFileConflict([{ id: 's1', files: ['modules/vpc'] }, { id: 's2', files: ['modules/vpc/main.tf'] }]).length, 1)
  assert.equal(H.groupByFileConflict([{ id: 's1', files: ['src/*.py'] }, { id: 's2', files: ['src/a.py'] }]).length, 1)
  assert.equal(H.groupByFileConflict([{ id: 's1', files: ['src/../src/a.py'] }, { id: 's2', files: ['src/a.py'] }]).length, 1)
})

test('a slice with no files runs alone and is logged', () => {
  const g = H.groupByFileConflict([{ id: 's1', files: [] }, { id: 's2', files: ['a.py'] }])
  assert.equal(g.length, 2)
  assert.ok(H.logs.some((l) => l.includes('s1') && l.includes('no files')))
})

test('mergePrices keeps every default a partial override does not name', () => {
  const p = H.mergePrices(H.DEFAULT_PRICES, { sonnet: { in: 3 } })
  assert.equal(p.sonnet.in, 3)
  assert.equal(p.sonnet.out, H.DEFAULT_PRICES.sonnet.out)
  assert.equal(p.sonnet.cache_read, H.DEFAULT_PRICES.sonnet.cache_read)
  assert.deepEqual(p.opus, H.DEFAULT_PRICES.opus)
  const q = H.mergePrices(H.DEFAULT_PRICES, { sonnet: { in: 'x' }, bogus: 1 })
  assert.equal(q.sonnet.in, H.DEFAULT_PRICES.sonnet.in)
  assert.equal(q.bogus, undefined)
})

test('fable is priced above opus on every meter', () => {
  const P = H.DEFAULT_PRICES
  for (const k of ['in', 'out', 'cache_read', 'cache_write']) assert.ok(P.fable[k] > P.opus[k], k)
  assert.equal(P.fable.cache_read, 1.0)
})

test('estimateRun never returns NaN or null and sums the lines', () => {
  const PROFILE = { implement: { model: 'sonnet', cache: 13, write: 0.17, out: 0.025, measured: true },
    spec: { model: 'opus', cache: 10, write: 0.3, out: 0.03, measured: false } }
  const e = H.estimateRun(PROFILE, H.DEFAULT_PRICES, { spec: 1 }, { implement: 3, unknown: 5, verify: 0 })
  assert.ok(Number.isFinite(e.spent_usd) && e.spent_usd > 0)
  assert.ok(Number.isFinite(e.ahead_usd) && e.ahead_usd > 0)
  assert.equal(e.assumed_usd, e.spent_usd)
  assert.deepEqual(Object.keys(e.lines), ['done:spec', 'ahead:implement'])
})

test('namespaced prefixes ids with the stage and drops duplicates', () => {
  const out = H.namespaced('spec', [{ id: 'Q1' }, { id: 'spec:Q1' }, { id: 'plan:Q2' }, { id: '' }])
  assert.deepEqual(out.map((q) => q.id), ['spec:Q1', 'spec:Q2'])
})

test('parseAnswers accepts a list or an object and sorts by id so a resume prompt is order-independent', () => {
  const a = H.parseAnswers([{ id: 'spec:Q2', answer: 'b' }, { id: 'spec:Q1', answer: 'a' }, { id: '', answer: 'x' }])
  assert.deepEqual(a, [{ id: 'spec:Q1', answer: 'a' }, { id: 'spec:Q2', answer: 'b' }])
  const b = H.parseAnswers({ 'plan:Q1': 'y', 'spec:Q1': 'z' })
  assert.deepEqual(b.map((x) => x.id), ['plan:Q1', 'spec:Q1'])
  assert.deepEqual(H.parseAnswers(undefined), [])
})

test('collectForOrchestrator carries open, handed-off, deferred and unclosed patches, honouring re_raises', () => {
  const open = [
    { id: 'r1:F1', severity: 'major', claim: 'still broken', re_raises: 'r0:F2' },
    { id: 'r1:F2', severity: 'minor', claim: 'new one' },
  ]
  const rounds = [{
    round: 1,
    handed_off: [{ id: 'r0:F5', severity: 'minor', claim: 'minor' }],
    deferred: [{ id: 'r0:F6', severity: 'major', claim: 'deferred' }],
    patched: [
      { finding: { id: 'r0:F1', severity: 'critical' }, patch: { status: 'fixed' }, verify: { verified: true } },
      { finding: { id: 'r0:F2', severity: 'major' }, patch: { status: 'fixed' }, verify: { verified: false } },
      { finding: { id: 'r0:F3', severity: 'major' }, patch: { status: 'disputed', notes: 'evidence' }, verify: { verified: true } },
      { finding: { id: 'r0:F4', severity: 'major' }, patch: null, verify: null },
    ],
  }]
  const out = H.collectForOrchestrator(open, rounds, true)
  const got = Object.fromEntries(out.map((f) => [f.id, f.source]))
  assert.equal(got['r1:F1'], 'final review')
  assert.equal(got['r1:F2'], 'final review')
  assert.equal(got['r0:F2'], undefined, 're-raised under r1:F1, so not duplicated')
  assert.equal(got['r0:F1'], undefined, 'fixed and verified, closed')
  assert.match(got['r0:F3'], /disputed/)
  assert.match(got['r0:F4'], /no patch/)
  assert.match(got['r0:F5'], /handed off/)
  assert.match(got['r0:F6'], /deferred/)
  assert.deepEqual(out.map((f) => f.severity).slice(0, 4), ['major', 'major', 'major', 'major'])
  assert.equal(out[out.length - 1].severity, 'minor')
})

test('collectForOrchestrator with no final review carries every patched finding', () => {
  const rounds = [{ round: 1, handed_off: [], deferred: [],
    patched: [{ finding: { id: 'r0:F1', severity: 'major' }, patch: { status: 'fixed' }, verify: { verified: true } }] }]
  const out = H.collectForOrchestrator([], rounds, false)
  assert.equal(out.length, 1)
  assert.match(out[0].source, /no final review/)
})

test('looksLikePath accepts a markdown path and rejects prose', () => {
  assert.equal(H.looksLikePath('docs/specs/2026-09-11-x.md'), true)
  assert.equal(H.looksLikePath('  docs/plans/a.md '), true)
  assert.equal(H.looksLikePath('add a slugify helper'), false)
  assert.equal(H.looksLikePath('see docs/plans/a.md'), false)
})

test('severityRank ranks critical < major < minor and treats unknown as minor', () => {
  assert.ok(H.severityRank('critical') < H.severityRank('major'))
  assert.ok(H.severityRank('major') < H.severityRank('minor'))
  assert.equal(H.severityRank('weird'), H.severityRank('minor'))
})

test('a ** glob overlaps a file at zero depth as well as a nested one', () => {
  assert.equal(H.pathsOverlap('src/**/*.py', 'src/a.py'), true)
  assert.equal(H.pathsOverlap('src/**/*.py', 'src/deep/er/a.py'), true)
  assert.equal(H.pathsOverlap('src/**', 'src/a.py'), true)
  assert.equal(H.pathsOverlap('src/**/*.py', 'lib/a.py'), false)
})

test('nested braces expand to every leaf', () => {
  assert.deepEqual([...new Set(H.expandBraces('src/{a,{b,c}}.py'))].sort(), ['src/a.py', 'src/b.py', 'src/c.py'])
})

test('a slice with no files is an exclusive group: it may not run beside anything', () => {
  const g = H.groupByFileConflict([{ id: 's1', files: [] }, { id: 's2', files: ['a.py'] }])
  assert.equal(g.length, 2)
  assert.equal(g.find((x) => x.slices[0].id === 's1').exclusive, true)
  assert.equal(g.find((x) => x.slices[0].id === 's2').exclusive, false)
  assert.ok(H.logs.some((l) => l.includes('s1') && l.includes('no files')))
})

test('footprintViolations names a touched file that another group declared', () => {
  const groups = H.groupByFileConflict([{ id: 's1', files: ['a.py'] }, { id: 's2', files: ['b.py'] }, { id: 's3', files: ['c.py'] }])
  const built = [
    { slice: { id: 's1', files: ['a.py'] }, impl: { slice_results: [{ id: 's1', status: 'done', files_touched: ['./a.py', 'b.py'], notes: '' }] } },
    { slice: { id: 's2', files: ['b.py'] }, impl: { slice_results: [{ id: 's2', status: 'done', files_touched: ['b.py', 'docs/x.md'], notes: '' }] } },
    { slice: { id: 's3', files: ['c.py'] }, impl: null },
  ]
  const v = H.footprintViolations(built, groups)
  assert.deepEqual(v, [{ slice: 's1', file: 'b.py', collides_with: ['s2'] }])
})

test('patchFootprint takes every file a finding names, falling back to the single file', () => {
  assert.deepEqual(H.patchFootprint({ id: 'F1', file: 'src/a.py' }), ['src/a.py'])
  assert.deepEqual(H.patchFootprint({ id: 'F2', file: 'src/a.py', files: ['src/a.py', 'test/a.test.py'] }), ['src/a.py', 'test/a.test.py'])
  assert.deepEqual(H.patchFootprint({ id: 'F3' }), [])
})

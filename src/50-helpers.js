// ---------------------------------------------------------------------------
// Pure helpers. No agent calls, no run state: paths and their overlap, slice
// grouping, prices, answers, finding ids, the review verdict, the orchestrator's
// list, and the fold-in proof. test/helpers.test.js pulls these out by name, so
// keep each one a top-level `function name(...) {}`.
// ---------------------------------------------------------------------------
// Repo-relative paths for the same file arrive spelled differently ("./src/a.py",
// "src/a.py", "src\\a.py", "src/./a.py", "/src/a.py", "src/../src/a.py"). Conflict
// detection compares these strings, so an unnormalised pair reads as disjoint and two
// agents get sent at one file — the exact failure the grouping exists to prevent.
// Separators are collapsed, "." and ".." segments resolved, leading and trailing "/"
// dropped.
function normPath(p) {
  const raw = String(p || '').trim().replace(/\\/g, '/')
  const out = []
  for (const seg of raw.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') { out.pop(); continue }
    out.push(seg)
  }
  return out.join('/')
}

// Two declared paths overlap when they are the same file, when one is a directory
// holding the other ("modules/vpc" vs "modules/vpc/main.tf" — the slicer is told to
// declare directories for Terraform modules), or when one is a glob that could match
// the other. A glob is turned into a regex where `**` spans directories and `*` one
// segment; a glob against a glob overlaps when either's literal prefix covers the
// other. Under-detection sends two agents at one file, so when in doubt, overlap.
function pathsOverlap(a, b) {
  if (a === b) return true
  if (a.startsWith(b + '/') || b.startsWith(a + '/')) return true
  const ga = a.includes('*'), gb = b.includes('*')
  if (!ga && !gb) return false
  // `**/` spans zero or more directories (src/**/*.py covers src/a.py as well as
  // src/deep/a.py), a bare `**` spans anything, `*` one segment.
  const globRe = (g) => {
    let re = ''
    for (let i = 0; i < g.length; i++) {
      if (g.startsWith('**/', i)) { re += '(?:.*/)?'; i += 2; continue }
      if (g.startsWith('**', i)) { re += '.*'; i += 1; continue }
      if (g[i] === '*') { re += '[^/]*'; continue }
      re += g[i].replace(/[.+^${}()|[\]\\?]/, '\\$&')
    }
    return new RegExp('^' + re + '(/.*)?$')
  }
  if (ga && !gb) return globRe(a).test(b)
  if (gb && !ga) return globRe(b).test(a)
  const pa = a.slice(0, a.indexOf('*')), pb = b.slice(0, b.indexOf('*'))
  return pa.startsWith(pb) || pb.startsWith(pa)
}

// Planners write `src/{a,b}.py` for two files. Expand it, or the pair compares
// as one exotic path that matches nothing and both slices read as disjoint.
function expandBraces(p) {
  const m = /^(.*?)\{([^{}]*)\}(.*)$/.exec(p)
  if (!m) return [p]
  return m[2].split(',').flatMap((alt) => expandBraces(m[1] + alt.trim() + m[3]))
}

// A slice's declared footprint. Under-detection is the dangerous direction: it
// puts two agents inside one file at the same time. Over-detection costs only
// wall-clock, never context — so when in doubt, collide.
function declaredFiles(s, quiet) {
  const out = new Set()
  for (const raw of s.files || []) {
    for (const p of expandBraces(String(raw || ''))) {
      const f = normPath(p)
      if (!f) continue
      if (f.includes('*') && !quiet) {
        log('WARNING: slice ' + s.id + ' declared a glob (' + f + ') — it collides with every declared path it could match')
      }
      out.add(f)
    }
  }
  return out
}

// Slices that touch a common file cannot run concurrently. Union them into a
// group; the group's slices run SEQUENTIALLY — one agent each, never merged
// into one context — and groups run in parallel. A slice with no declared
// files gets its own group marked EXCLUSIVE, because an unknown footprint cannot
// be proven disjoint from anything: the engine runs such a group with nothing
// else live, after the grouped slices. Within a group the slices keep the PLAN'S order: a slice
// that bridges two earlier groups used to be appended ahead of the second
// group's slices, so Task 3 ran before the Task 2 it consumed from.
function groupByFileConflict(slices) {
  const groups = []
  slices.forEach((s, index) => {
    const files = declaredFiles(s)
    const entry = { slice: s, index }
    if (files.size === 0) {
      log('WARNING: slice ' + s.id + ' declared no files — footprint unknown, so it runs with nothing else live')
      groups.push({ entries: [entry], files })
      return
    }
    const hits = groups.filter((g) => [...files].some((f) => [...g.files].some((h) => pathsOverlap(f, h))))
    if (hits.length === 0) {
      groups.push({ entries: [entry], files })
      return
    }
    const target = hits[0]
    target.entries.push(entry)
    for (const f of files) target.files.add(f)
    for (const extra of hits.slice(1)) {
      target.entries.push(...extra.entries)
      for (const f of extra.files) target.files.add(f)
      const at = groups.indexOf(extra)
      if (at >= 0) groups.splice(at, 1)
    }
  })
  return groups
    .map((g) => ({ ...g, entries: g.entries.sort((a, b) => a.index - b.index) }))
    .sort((a, b) => a.entries[0].index - b.entries[0].index)
    .map((g) => ({ slices: g.entries.map((e) => e.slice), files: g.files, exclusive: g.files.size === 0 }))
}

// The orchestrator's slices (from:'slices') are checked here before anything is spent: a
// malformed slice is an argument error, not a lane's. Returns one message per problem,
// empty when the list is usable. The text fields must BE strings, not merely coerce to
// one: `String({text:'do a'})` is "[object Object]", and an implementer plus two review
// passes would be paid to build from it. `id` may also be a number (s1 or 1). `files` may
// be empty (an unknown footprint runs alone), but it must be a list of strings; extra
// fields are ignored.
function sliceArgErrors(raw, max) {
  if (!Array.isArray(raw)) return ['slices must be an array of {id, title, prompt, files, done_when}']
  if (!raw.length) return ['slices is empty']
  const out = []
  if (raw.length > max) out.push(raw.length + ' slices exceed maxSlices (' + max + ', which the engine caps at 20): this is not a small build')
  const seen = new Set()
  raw.forEach((s, i) => {
    const at = 'slices[' + i + ']'
    if (!s || typeof s !== 'object' || Array.isArray(s)) { out.push(at + ' is not an object'); return }
    const id = typeof s.id === 'string' || typeof s.id === 'number' ? String(s.id).trim() : ''
    if (!id) out.push(at + ' has no id (a string or a number)')
    else if (seen.has(id)) out.push(at + ' repeats id "' + id + '"')
    seen.add(id)
    for (const k of ['title', 'prompt', 'done_when']) {
      if (typeof s[k] !== 'string' || !s[k].trim()) out.push(at + (id ? ' (' + id + ')' : '') + ' has no ' + k + ' (a non-empty string)')
    }
    if (!Array.isArray(s.files) || s.files.some((f) => typeof f !== 'string' || !f.trim())) {
      out.push(at + (id ? ' (' + id + ')' : '') + ' needs files: an array of repo-relative path strings (empty is allowed and means an unknown footprint)')
    }
  })
  return out
}

// After the implement phase: every file an implementer reports touching that is outside
// its declared set AND inside another group's declared set was edited while that group
// may have been live in the same tree. That is the collision the grouping exists to
// prevent, and no prompt can rule it out — so it is checked here and held against the run.
function footprintViolations(built, groups) {
  const out = []
  const groupOf = (id) => groups.find((g) => g.slices.some((x) => x.id === id))
  for (const b of built) {
    if (!b || !b.impl) continue
    const declared = [...declaredFiles(b.slice, true)]
    const mine = groupOf(b.slice.id)
    for (const r of b.impl.slice_results || []) {
      for (const raw of r.files_touched || []) {
        const f = normPath(raw)
        if (!f || declared.some((d) => pathsOverlap(f, d))) continue
        const collides = groups
          .filter((g) => g !== mine && [...g.files].some((h) => pathsOverlap(f, h)))
          .flatMap((g) => g.slices.map((x) => x.id))
        if (collides.length) out.push({ slice: b.slice.id, file: f, collides_with: collides })
      }
    }
  }
  return out
}

// A finding's footprint for patch grouping: every file the reviewer says a fix would
// touch (`files`, which should include the test file), else the single `file`, else
// nothing — and nothing means an exclusive group.
function patchFootprint(f) {
  if (Array.isArray(f.files) && f.files.length) return f.files.map(String)
  return f.file ? [String(f.file)] : []
}

// Seconds per phase, summed over its lanes, plus the run's wall clock so far. Lanes
// that ran in parallel are summed, not overlapped: the figure is agent time, and
// the run total is the wall clock.
function timingByPhase(timings, runSeconds) {
  const by = {}
  for (const t of timings || []) { by[t.phase || 'other'] = (by[t.phase || 'other'] || 0) + (t.seconds || 0) }
  return { run_wall_clock_seconds: runSeconds, agent_seconds_by_phase: by, lanes: timings || [] }
}

function severityRank(sev) {
  if (sev === 'critical') return 0
  if (sev === 'major') return 1
  return 2
}

// A price override is merged per field and only where the value is a finite number;
// a model the defaults do not know is ignored (the estimate has no profile row for it).
function mergePrices(defaults, override) {
  const out = {}
  for (const model of Object.keys(defaults)) {
    out[model] = { ...defaults[model] }
    const row = override && typeof override === 'object' && override[model] && typeof override[model] === 'object' ? override[model] : null
    if (!row) continue
    for (const k of Object.keys(defaults[model])) {
      if (Number.isFinite(row[k]) && row[k] >= 0) out[model][k] = row[k]
    }
  }
  return out
}

// args.answers as a list of {id, answer} or an {id: answer} object, sorted by id.
function parseAnswers(raw) {
  let list = []
  if (Array.isArray(raw)) {
    list = raw.filter((a) => a && a.id).map((a) => ({ id: String(a.id), answer: String(a.answer || '') }))
  } else if (raw && typeof raw === 'object') {
    list = Object.keys(raw).map((k) => ({ id: String(k), answer: String(raw[k] || '') }))
  }
  return list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

// Everything the orchestrator must close by hand, at EVERY severity, sorted critical
// first: what the final review left standing; every finding a round handed off (below
// PATCH_SEVERITY) or deferred (past the per-round cap); and every finding a round tried
// to patch that did not come back closed — the patcher returned nothing, failed, or
// disputed it. A later review that simply did not mention one of THOSE has not closed
// it; only a final-review finding whose `re_raises` names it supersedes it (then the
// newer entry stands and the old one is dropped). A patch reported fixed is closed on
// the patcher's word plus the re-review's silence — the re-review reads every patch
// diff and is told to re-raise what is not genuinely closed; that is a deliberate
// trade, not an oversight. With no final review at all, nothing is treated as closed.
function collectForOrchestrator(openFindings, rounds, hasFinalReview) {
  const out = []
  const seen = new Set()
  const superseded = new Set()
  const add = (f, source) => {
    if (!f || !f.id || seen.has(f.id) || superseded.has(f.id)) return
    seen.add(f.id)
    out.push({ ...f, source })
  }
  for (const f of openFindings || []) {
    if (f && f.re_raises) superseded.add(String(f.re_raises))
    add(f, 'final review')
  }
  for (const r of rounds || []) {
    for (const p of r.patched || []) {
      const f = p && p.finding
      if (!f) continue
      const status = p.patch ? p.patch.status : null
      if (!hasFinalReview) add(f, 'patched in round ' + r.round + ', but there was no final review to confirm it closed')
      else if (!p.patch) add(f, 'no patch: the patcher returned nothing in round ' + r.round)
      else if (status === 'disputed') add(f, 'disputed by the patcher in round ' + r.round + ' — judge the evidence: ' + String(p.patch.notes || '').slice(0, 300))
      else if (status !== 'fixed') add(f, 'patch ' + status + ' in round ' + r.round)
    }
    for (const f of r.handed_off || []) add(f, 'handed off in round ' + r.round + ' (below the auto-patch severity)')
    for (const f of r.deferred || []) add(f, 'deferred in round ' + r.round + ' (past the per-round cap)')
  }
  return out.sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
}

// `clean`, `diff_reviewed`, `executed` and `findings` are independent fields in the
// schema, and a reviewer can return any combination. The engine derives clean from
// the others: a review is clean only if the diff was read, nothing was found AND —
// where the repo has a check command — the reviewer ran it. The adversary is the only
// lane that executes anything after the implementers' own self-reported runs, so a
// read-only review cannot be clean there. The reviewer's own boolean is kept as
// `claimed_clean` so a contradiction is visible.
function judgeReview(rev, hasChecks) {
  if (!rev) return rev
  const findings = Array.isArray(rev.findings) ? rev.findings : []
  const executed = rev.executed === true
  const clean = rev.diff_reviewed === true && findings.length === 0 && (!hasChecks || executed)
  if (rev.clean === true && !clean) {
    log('WARNING: the reviewer said clean:true ' + (findings.length ? 'but listed ' + findings.length + ' finding(s)' : rev.diff_reviewed !== true ? 'without reading the diff' : 'without running the check') + ' — treated as NOT clean')
  }
  return { ...rev, findings, clean, executed, claimed_clean: rev.clean === true, dirty_paths: String(rev.dirty_paths || '').replace(/\s+$/, '') }
}

function looksLikePath(t) {
  return /^[\w./-]+\.md$/.test(t.trim()) && !/\s/.test(t.trim())
}

// Questions are namespaced by stage ("spec:Q1") so an answer given for the spec's
// pause is never mistaken for a plan question of the same local id, and so the
// apply-answers prompt for the spec stays byte-identical across a later resume.
// Two DIFFERENT questions (or findings) that arrive with the same local id — the spec
// writer's Q1 and the reviewer's Q1 — are both kept; the second is suffixed "-2". Only
// an item whose id AND text repeat is a duplicate and dropped.
function namespaced(stage, qs) {
  const seen = new Map()
  const out = []
  for (const q of qs || []) {
    if (!q || !q.id) continue
    const base = stage + ':' + String(q.id).replace(/^\w+:/, '')
    const text = String(q.question || q.claim || '')
    let id = base
    for (let n = 2; seen.has(id) && seen.get(id) !== text; n++) id = base + '-' + n
    if (seen.has(id)) continue
    seen.set(id, text)
    out.push({ ...q, id })
  }
  return out
}

// A finding is folded in when the document changed, not when a reviewer says so. Every
// finding leaves at least a row in the fold-in record, so a review with findings must
// report a NEW commit (not the writer's, not the previous round's) whose `git show --stat`
// lists the document. Returns null when that holds, else what is missing.
function docEditUnproven(findingCount, sha, stat, docPath, priorSha) {
  if (!findingCount) return null
  const s = String(sha || '').trim()
  const p = String(priorSha || '').trim()
  if (!s) return 'reported no commit'
  if (p && (s.startsWith(p) || p.startsWith(s))) return 'reported the previous commit on the document (' + s.slice(0, 8) + '), not a new one'
  const base = String(docPath || '').split('/').pop()
  if (!base || !statListsDoc(stat, docPath)) return 'showed a `git show --stat` that does not list ' + docPath
  return null
}

// `git show --stat` wraps its path column to a terminal width and elides a long path from the
// LEFT with `...`, so a path this engine writes itself (`docs/specs/<yyyy-mm-dd>-<slug>.md`) can
// come back as `...-<slug>.md` — the basename's own date prefix gone. A literal `includes(base)`
// then fails on a fold-in that genuinely happened; on 2026-09-14 that stopped a run at
// `spec-review` twice, reviewer and editor lane alike, on a spec both had correctly committed.
// So compare the way git prints it: take each stat row's path cell, drop a leading `...`, and
// accept the row when the document's full path ends with what is left.
function statListsDoc(stat, docPath) {
  const full = String(docPath || '').trim()
  if (!full) return false
  const base = full.split('/').pop()
  const text = String(stat || '')
  if (text.includes(full) || text.includes(base)) return true
  for (const line of text.split('\n')) {
    // a diffstat row is ` <path> | <n> <+-/Bin>`; the rename form ` a => b` keeps its target last
    const bar = line.indexOf('|')
    if (bar < 0) continue
    let cell = line.slice(0, bar).trim()
    if (!cell) continue
    const arrow = cell.lastIndexOf('=>')
    if (arrow >= 0) cell = cell.slice(arrow + 2).trim().replace(/\}$/, '')
    if (!cell.startsWith('...')) continue
    const tail = cell.slice(3)
    if (tail && full.endsWith(tail)) return true
  }
  return false
}

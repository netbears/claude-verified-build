// ---------------------------------------------------------------------------
// Lanes. Every agent call goes through callAgent: it never throws, records every
// failure in laneErrors, retries once on the fallback tier, and times the lane.
// wavesOne / runGroups schedule the implement and patch lanes in bounded waves.
// ---------------------------------------------------------------------------
// Every lane that fails or throws is recorded here and reported; nothing is silent.
const laneErrors = []
const fallbacksUsed = []
// Wall clock per lane, in seconds, primary and fallback attempts summed. The six-run
// phase table in the skill was reconstructed from transcripts by hand; this makes the
// next run report it, so the question "which stage is slow" has an answer in the result.
const laneTimings = []
// The Workflow runtime forbids the wall clock in a script (a script must replay identically
// on resume) and since 2026-09-12 rejects the script text statically before it runs. The
// monotonic clock is the one it leaves; where the sandbox has none, a lane's seconds are
// null, timingByPhase skips them, and the run is otherwise unaffected.
function clock() {
  try { return (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : null } catch (e) { return null }
}
const RUN_T0 = clock()
function elapsed(t0) { const n = clock(); return (n == null || t0 == null) ? null : Math.round((n - t0) / 1000) }

// A lane's fallback is keyed on the MODEL it ran on, not on its role: the two pinned
// tiers keep their overridable answers, and anything else steps to the next tier up (and
// back down from the top). Until v1.7.0 this returned null for any third model, so a
// document lane moved onto Fable by docJudge would have had NO fallback — and a document
// reviewer lost to a 529 storm stops the run at stage:'spec-review' with nothing built.
const NEXT_TIER = { sonnet: 'opus', opus: 'fable', fable: 'opus' }
function fallbackFor(model) {
  if (model === CODER) return CODER_FALLBACK
  if (model === JUDGE) return JUDGE_FALLBACK
  return NEXT_TIER[model] || null
}

// Never throws. agent() returns null on a terminal API error or a skip, but it THROWS
// once the turn's token budget is exhausted (and on a few runtime errors); inside
// parallel() a throw silently turned a whole implement group into null, and at top
// level it aborted the run with no report. Every failure now lands in laneErrors and
// the lane returns null, which every caller already handles.
async function callAgent(prompt, opts) {
  const t0 = clock()
  try { return await callAgentInner(prompt, opts) }
  finally {
    const o = opts || {}
    const secs = elapsed(t0)
    laneTimings.push({ label: o.label || 'agent', phase: o.phase || null, model: o.model || null, seconds: secs })
    log((o.label || 'agent') + ': ' + (secs == null ? '?' : secs + 's') + ' (run at +' + (elapsed(RUN_T0) == null ? '?' : elapsed(RUN_T0) + 's') + ')')
  }
}

async function callAgentInner(prompt, opts) {
  const o = opts || {}
  const label = o.label || 'agent'
  let first = null
  let firstError = null
  try {
    first = await agent(prompt, o)
  } catch (e) {
    firstError = e
  }
  if (first !== null && first !== undefined) return first
  const why = firstError ? String(firstError.message || firstError).slice(0, 160) : 'returned nothing (terminal API error, or skipped)'
  laneErrors.push({ label: label, model: o.model || null, error: why })
  const fb = FALLBACK ? fallbackFor(o.model) : null
  if (!fb || fb === o.model) {
    log(label + ': ' + (o.model || 'default') + ' ' + why + ' - no fallback tier, lane lost')
    return null
  }
  log(label + ': ' + (o.model || 'default') + ' ' + why + ' - retrying once on ' + fb)
  fallbacksUsed.push({ label: label, primary: o.model || null, fallback: fb })
  try {
    const second = await agent(prompt, { ...o, model: fb, label: label + ':fb-' + fb })
    if (second === null || second === undefined) {
      laneErrors.push({ label: label + ':fb-' + fb, model: fb, error: 'returned nothing (terminal API error, or skipped)' })
      log(label + ': the fallback on ' + fb + ' returned nothing too - lane lost')
    }
    return second === undefined ? null : second
  } catch (e) {
    laneErrors.push({ label: label + ':fb-' + fb, model: fb, error: String(e.message || e).slice(0, 160) })
    log(label + ': the fallback on ' + fb + ' threw (' + String(e.message || e).slice(0, 120) + ') - lane lost')
    return null
  }
}

// The turn's token target ("+500k") is a hard ceiling: past it every agent() throws.
// Checked between phases so the run returns a report instead of a wall of lost lanes.
function budgetLeft(need) {
  return !(budget.total && budget.remaining() < need)
}
// Run items through ONE stage in waves of `size`, at most `size` agents live.
async function wavesOne(items, size, fn, what) {
  const out = []
  for (let i = 0; i < items.length; i += size) {
    const chunk = items.slice(i, i + size)
    if (items.length > size) {
      log((what || 'wave') + ' ' + (Math.floor(i / size) + 1) + '/' + Math.ceil(items.length / size) +
        ' (' + chunk.length + ' item(s))')
    }
    const got = await parallel(chunk.map((it, j) => () => fn(it, i + j)))
    out.push(...got)
  }
  return out
}

// Groups run in waves of `size`; the exclusive ones (unknown footprint) run one at a
// time afterwards, with nothing else live. Used by the implement and patch phases.
async function runGroups(groups, size, fn, what) {
  const shared = groups.filter((g) => !g.exclusive)
  const exclusive = groups.filter((g) => g.exclusive)
  const out = await wavesOne(shared, size, fn, what)
  if (exclusive.length) {
    log(what + ': ' + exclusive.length + ' group(s) with an unknown footprint run one at a time, nothing else live')
    out.push(...await wavesOne(exclusive, 1, fn, what + ' (exclusive)'))
  }
  return out
}

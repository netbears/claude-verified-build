// ---------------------------------------------------------------------------
// Token profile per agent, in MILLIONS of tokens: cache reads, cache writes,
// output. Measured over six runs on one repo, 9–11 Sep 2026 (262 agents, ~2.3B
// cached-read tokens, reconstructed from every agent's transcript). The front
// half (spec/plan writers, document reviewers, fold-ins, recorder) had not run
// when this was written; those rows are ASSUMPTIONS and are labelled so in the
// estimate. Refine them from a run's transcripts once there are some.
// ---------------------------------------------------------------------------
const PROFILE = {
  recon: { model: CODER, cache: 5.5, write: 0.2, out: 0.017, measured: true },
  slice: { model: JUDGE, cache: 1.0, write: 0.2, out: 0.015, measured: true },
  implement: { model: CODER, cache: 13.0, write: 0.17, out: 0.025, measured: true },   // per slice
  review: { model: JUDGE, cache: 17.0, write: 0.45, out: 0.011, measured: true },      // per adversarial pass (now also runs the check)
  patch: { model: CODER, cache: 12.0, write: 0.08, out: 0.030, measured: true },       // per patched finding
  // The five document rows follow docWriter / docJudge, so the cost gate prices the run
  // the caller actually asked for: on the default tiers this is what it always was, and
  // a `docWriter:'opus', docJudge:'fable'` run shows its front half at roughly double
  // before a line of code is written. plan_index stays on the CODER tier deliberately —
  // it only re-measures line numbers in a document that already exists.
  spec: { model: DOC_WRITER, cache: 10.0, write: 0.3, out: 0.030, measured: false },     // on the CODER tier since v1.5.0
  doc_review: { model: DOC_JUDGE, cache: 18.0, write: 0.4, out: 0.035, measured: false },// reviews AND folds in (spec 7.6+4.7M / plan 19+6.5M cache measured as two lanes on 2026-09-11)
  plan_doc: { model: DOC_WRITER, cache: 20.0, write: 0.4, out: 0.060, measured: false }, // on the CODER tier since v1.5.0
  plan_review: { model: DOC_JUDGE, cache: 25.0, write: 0.4, out: 0.020, measured: false },
  answers: { model: DOC_JUDGE, cache: 8.0, write: 0.2, out: 0.015, measured: false },
  plan_index: { model: CODER, cache: 1.5, write: 0.05, out: 0.003, measured: false },
  probe: { model: CODER, cache: 0.01, write: 0.005, out: 0.0002, measured: false },      // per model probed
}

function priceOf(prices, model) {
  return prices[model] || prices.opus
}

function lineCost(row, prices, n) {
  const p = priceOf(prices, row.model)
  const usd = n * (row.cache * p.cache_read + row.write * p.cache_write + row.out * p.out)
  return { agents: n, model: row.model, measured: row.measured,
    cache_mtok: +(n * row.cache).toFixed(1), write_mtok: +(n * row.write).toFixed(2), out_mtok: +(n * row.out).toFixed(3),
    usd: +usd.toFixed(2) }
}

function estimateRun(profile, prices, spent, ahead) {
  // spent / ahead: { <profile key>: count }. Returns the breakdown and the totals.
  const lines = {}
  let spentUsd = 0
  let aheadUsd = 0
  let assumed = 0
  for (const [k, n] of Object.entries(spent)) {
    if (!n || !profile[k]) continue
    const l = lineCost(profile[k], prices, n); lines['done:' + k] = l; spentUsd += l.usd; if (!l.measured) assumed += l.usd
  }
  for (const [k, n] of Object.entries(ahead)) {
    if (!n || !profile[k]) continue
    const l = lineCost(profile[k], prices, n); lines['ahead:' + k] = l; aheadUsd += l.usd; if (!l.measured) assumed += l.usd
  }
  return { lines, spent_usd: +spentUsd.toFixed(2), ahead_usd: +aheadUsd.toFixed(2), assumed_usd: +assumed.toFixed(2) }
}

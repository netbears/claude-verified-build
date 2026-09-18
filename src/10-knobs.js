// ---------------------------------------------------------------------------
// Knobs. WAVE is the "up to 15 parallel agents" contract: work is chunked into
// waves of this size, so concurrency is bounded by the script and not only by
// the runtime cap (min(16, cpus-2)), which on a small box is the tighter of the two.
// ---------------------------------------------------------------------------
const input = typeof args === 'string' ? { task: args } : (args || {})
const TASK = String(input.task || '').trim()
if (!TASK) {
  throw new Error('build-verify-patch: no task. Pass args:{task:"..."} or a plain string.')
}
const TEST_CMD = String(input.testCmd || '').trim()
const WAVE = Number(input.wave) > 0 ? Math.min(Number(input.wave), 16) : 15
// 2026-09-11: default 1, was 2. Measured over six runs (25h of wall clock, ~2.3B cached
// tokens): the patch rounds were 46% of the time and 51% of the tokens, and the SECOND
// round's net effect was ~zero every time — it closed 4/2/5 findings and the re-review
// found 5/2/2 new ones, three of them introduced by the patches themselves. The
// leftovers are cheaper and safer for the orchestrator to patch by hand.
const MAX_ROUNDS = Number.isInteger(input.maxRounds) ? Math.max(0, Math.min(input.maxRounds, 4)) : 1
// Only findings at or above this severity are auto-patched; the rest are handed back
// in `open_findings` (and per round in `handed_off`). Minor findings were ~40% of what
// got patched and the place patchers most often drifted into inventing things.
const PATCH_SEVERITY = ['critical', 'major', 'minor'].includes(input.patchSeverity) ? input.patchSeverity : 'major'
// Where the run starts. 'idea': task is a paragraph, a prompt, a test, an idea — the engine
// writes the spec and the plan itself. 'spec': task is (or names the path of) a finished spec —
// skip straight to the plan. 'plan': task is (or names) a finished, reviewed plan — slice it.
const FROM = ['idea', 'spec', 'plan'].includes(input.from) ? input.from : 'idea'
// Adversarial review rounds on each document the engine writes (0 = write, do not review).
const DOC_ROUNDS = Number.isInteger(input.docRounds) ? Math.max(0, Math.min(input.docRounds, 2)) : 1
// Where the documents go; Recon reports the repo's own convention when it has one, and these
// override it. Empty means "use the repo's convention, else docs/specs and docs/plans".
const SPEC_DIR_IN = String(input.specDir || '').trim()
const PLANS_DIR_IN = String(input.plansDir || '').trim()
// Optional: a finished spec or plan path when FROM is 'spec' or 'plan' and the task text is
// not itself the path.
const SPEC_PATH_IN = String(input.spec || '').trim()
const PLAN_PATH_IN = String(input.plan || '').trim()
// Owner questions. A spec or plan writer that meets a decision the owner should make —
// money, risk, data, ownership, a reversal of something that exists, or a choice careful
// colleagues would make differently — records it as a QUESTION with options and a
// recommendation instead of deciding. If any such question is unanswered when its stage
// ends, the run RETURNS EARLY ({paused:true, questions:[…]}) so the orchestrator can ask
// the user, then relaunches with resumeFromRunId and args.answers; every agent before the
// pause replays from cache because no prompt before it mentions the answers.
// pauseForOwner:false restores the fully autonomous run: the recommended option stands.
// The cost gate. Before the first implementer runs, the engine computes what the rest of
// the run would cost at Anthropic's first-party API list prices (a non-subscription
// licence) from a per-agent token profile measured over six runs, and RETURNS EARLY with
// it unless approveEstimate:true was passed (or maxUsd covers the expected figure). The
// orchestrator shows it to the user and resumes the same run; everything before the gate
// replays from cache. Subscription users are not billed per token — the figure is what
// the run would cost at list prices, which is still the honest measure of its size.
const APPROVE_ESTIMATE = input.approveEstimate === true
const MAX_USD = Number(input.maxUsd) > 0 ? Number(input.maxUsd) : null
// USD per million tokens, Anthropic first-party API list prices (cached 2026-06-24):
// input / output / cache read (0.1x input) / cache write (5-minute, 1.25x input).
// Override with args.prices = { sonnet: {...}, opus: {...}, fable: {...} } when the
// list changes; an override is merged PER FIELD, so `{sonnet: {in: 3}}` changes one
// number and keeps the rest — replacing the whole row used to turn every cost into
// null, and a null total passed any maxUsd.
const DEFAULT_PRICES = {
  sonnet: { in: 2, out: 10, cache_read: 0.20, cache_write: 2.50 },
  opus: { in: 5, out: 25, cache_read: 0.50, cache_write: 6.25 },
  fable: { in: 10, out: 50, cache_read: 1.00, cache_write: 12.50 },
}
const PRICES = mergePrices(DEFAULT_PRICES, input.prices)
const PAUSE_FOR_OWNER = input.pauseForOwner !== false
// Sorted by id: the prompt that records the owner's answers embeds them, and a resume
// replays an agent only while its prompt is byte-identical — the order the orchestrator
// happened to pass them in must not decide whether the author runs again.
const ANSWERS = parseAnswers(input.answers)
const MAX_SLICES = Number(input.maxSlices) > 0 ? Math.min(Number(input.maxSlices), 20) : 15
const MAX_PATCH_PER_ROUND = 15
const CODER = 'sonnet'
const JUDGE = 'opus'
// The five DOCUMENT lanes — spec writer, plan writer, both document reviewers, and the
// author that records the owner's answers — ride on their own two knobs, defaulting to
// the pinned tiers so an unqualified run is exactly what it was before v1.7.0. Raising
// them (`docWriter:'opus', docJudge:'fable'`) buys stronger design without touching the
// implement lane, where the token volume actually is: the front half is ~10 agents, the
// back half is one per slice plus one per patched finding, each re-reading the repo.
// A value the engine does not know is refused OUT LOUD and the default stands: a typo
// silently meaning "the default" is how a run gets reported as having been reviewed by
// a model that never saw it.
const MODEL_ALIASES = ['sonnet', 'opus', 'fable']
function pickModel(raw, dflt, what) {
  const m = String(raw == null ? '' : raw).trim().toLowerCase()
  if (!m) return dflt
  if (MODEL_ALIASES.includes(m)) return m
  log('ignoring ' + what + ':"' + m + '" — not one of ' + MODEL_ALIASES.join(' / ') + '; that lane stays on ' + dflt)
  return dflt
}
const DOC_WRITER = pickModel(input.docWriter, CODER, 'docWriter')
const DOC_JUDGE = pickModel(input.docJudge, JUDGE, 'docJudge')
// Every model this run will use as a PRIMARY, in a stable order: what the probe phase
// checks and what the estimate prices its probes at.
const PRIMARY_MODELS = [...new Set([CODER, JUDGE, DOC_WRITER, DOC_JUDGE])]
const EFFORT = ['low', 'medium', 'high', 'xhigh', 'max'].includes(input.effort) ? input.effort : 'high'
// One trivial call per primary model before anything is spent. On an API-key (non-
// subscription) account a model alias may be disabled for the organisation, and the
// engine would otherwise discover that fifteen agents deep as a wall of nulls.
const PROBE_MODELS = input.probeModels !== false
// A task that is only a path (from:'spec' or 'plan') must be READ, not quoted: a
// verifier handed "OVERALL TASK: docs/specs/x.md" and nothing else has no bar to hold
// the work to.
const TASK_TEXT = looksLikePath(TASK)
  ? 'The task is the document at `' + TASK.trim() + '`. Read it whole before anything else; it is the bar the work must clear.'
  : TASK
// Safety gates. Both default ON: several agents commit concurrently into the
// session's working directory, so a dirty tree or a shared trunk is a real
// hazard rather than a style preference. Callers who know better can opt out.
const ALLOW_DIRTY = input.allowDirty === true
const ALLOW_TRUNK = input.allowTrunk === true

// Fallback tiers. agent() returns null when a subagent dies on a terminal API
// error after the runtime's own retries (a 529 Overloaded storm, typically), and
// an adversary that returned null is a diff nobody reviewed. One retry on the other
// tier turns a one-model outage into a slower run instead of an unverified one.
// 2026-09-03: Opus was overloaded for ~90 minutes, every judge lane returned null,
// and the run reported ok:true with zero verification. This is the fix.
// Caveat: agent() also returns null when the user skips an agent mid-run, and the
// two are indistinguishable here, so a skipped agent gets one fallback attempt.
// Pass fallback:false to disable; judgeFallback / coderFallback change the tiers.
const FALLBACK = input.fallback !== false
const CODER_FALLBACK = String(input.coderFallback || 'opus')
const JUDGE_FALLBACK = String(input.judgeFallback || 'fable')

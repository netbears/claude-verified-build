export const meta = {
  name: 'build-verify-patch',
  description: 'From an idea: Opus writes the spec, adversarially reviews and folds it in, writes the plan, reviews and folds that in; then Sonnet implements in waves of 15, Opus verifies every commit, Opus adversarially reviews the combined diff, and one patch round closes critical/major findings',
  whenToUse: 'A multi-file feature, refactor, migration or non-trivial bugfix where you want the code written cheaply, verified by a model that did not write it, and attacked before you trust it. Works on any git repo in any language. Overkill for a one-line fix.',
  phases: [
    { title: 'Recon', detail: 'sonnet reads the repo: git state, ecosystem, how it verifies itself', model: 'sonnet' },
    { title: 'Spec', detail: 'opus turns the idea into a spec (brainstorming doctrine), commits it', model: 'opus' },
    { title: 'Spec review', detail: 'opus adversarially reviews the spec; opus folds the findings in', model: 'opus' },
    { title: 'Plan', detail: 'opus writes the implementation plan from the spec (writing-plans doctrine), commits it', model: 'opus' },
    { title: 'Plan review', detail: 'opus adversarially reviews the plan against the tree; opus folds the findings in', model: 'opus' },
    { title: 'Slice', detail: 'opus maps the plan\'s tasks onto file-disjoint slices', model: 'opus' },
    { title: 'Implement', detail: 'sonnet writes and commits each slice', model: 'sonnet' },
    { title: 'Verify', detail: 'opus re-runs the repo\'s checks and reads the real diff', model: 'opus' },
    { title: 'Review', detail: 'opus adversarially reviews the combined diff', model: 'opus' },
    { title: 'Patch', detail: 'sonnet fixes each critical/major finding, opus re-verifies (1 round by default)', model: 'sonnet' },
  ],
}

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
const PAUSE_FOR_OWNER = input.pauseForOwner !== false
const ANSWERS = Array.isArray(input.answers)
  ? input.answers.filter((a) => a && a.id).map((a) => ({ id: String(a.id), answer: String(a.answer || '') }))
  : (input.answers && typeof input.answers === 'object'
    ? Object.keys(input.answers).map((k) => ({ id: String(k), answer: String(input.answers[k] || '') }))
    : [])
const MAX_SLICES = Number(input.maxSlices) > 0 ? Math.min(Number(input.maxSlices), 20) : 15
const MAX_PATCH_PER_ROUND = 15
const CODER = 'sonnet'
const JUDGE = 'opus'
const EFFORT = String(input.effort || 'high')
// Safety gates. Both default ON: several agents commit concurrently into the
// session's working directory, so a dirty tree or a shared trunk is a real
// hazard rather than a style preference. Callers who know better can opt out.
const ALLOW_DIRTY = input.allowDirty === true
const ALLOW_TRUNK = input.allowTrunk === true

// Fallback tiers. agent() returns null when a subagent dies on a terminal API
// error after the runtime's own retries (a 529 Overloaded storm, typically), and
// a verifier that returned null is a slice nobody checked. One retry on the other
// tier turns a one-model outage into a slower run instead of an unverified one.
// 2026-09-03: Opus was overloaded for ~90 minutes, every judge lane returned null,
// and the run reported ok:true with zero verification. This is the fix.
// Caveat: agent() also returns null when the user skips an agent mid-run, and the
// two are indistinguishable here, so a skipped agent gets one fallback attempt.
// Pass fallback:false to disable; judgeFallback / coderFallback change the tiers.
const FALLBACK = input.fallback !== false
const CODER_FALLBACK = String(input.coderFallback || 'opus')
const JUDGE_FALLBACK = String(input.judgeFallback || 'fable')
const fallbacksUsed = []

function fallbackFor(model) {
  if (model === CODER) return CODER_FALLBACK
  if (model === JUDGE) return JUDGE_FALLBACK
  return null
}

async function callAgent(prompt, opts) {
  const o = opts || {}
  let first = null
  let firstError = null
  try {
    first = await agent(prompt, o)
  } catch (e) {
    firstError = e
  }
  if (first !== null && first !== undefined) return first
  const fb = FALLBACK ? fallbackFor(o.model) : null
  if (!fb || fb === o.model) {
    if (firstError) throw firstError
    return first
  }
  const label = o.label || 'agent'
  log(label + ': ' + (o.model || 'default') + ' returned nothing' +
    (firstError ? ' (' + String(firstError.message || firstError).slice(0, 120) + ')' : ' (terminal API error, or skipped)') +
    ' - retrying once on ' + fb)
  fallbacksUsed.push({ label: label, primary: o.model || null, fallback: fb })
  return agent(prompt, { ...o, model: fb, label: label + ':fb-' + fb })
}

// Every ecosystem names its own verification differently, and the repo — not
// this script — is the authority. This list exists so the recon agent looks in
// the right places instead of assuming Make and npm.
const DISCOVERY_HINTS = [
  'CLAUDE.md, AGENTS.md, CONTRIBUTING.md, README — a stated command always wins over an inferred one.',
  'CI config, which is the most reliable source of the command that must actually pass:',
  '  .gitlab-ci.yml, .github/workflows/*, azure-pipelines.yml, Jenkinsfile, .pre-commit-config.yaml',
  'Task runners: Makefile, justfile, Taskfile.yml, package.json scripts, tox.ini, noxfile.py',
  'Per-ecosystem manifests:',
  '  python      pyproject.toml, setup.cfg, pytest.ini, requirements*.txt (prefer a venv binary if one exists)',
  '  node        package.json (npm/pnpm/yarn test), vitest/jest config',
  '  go          go.mod -> `go test ./...`',
  '  rust        Cargo.toml -> `cargo test`',
  '  java/kotlin pom.xml -> `mvn test`; build.gradle -> `./gradlew test`',
  '  ruby        Gemfile -> `bundle exec rspec`',
  '  php         composer.json -> `composer test`',
  '  dotnet      *.sln/*.csproj -> `dotnet test`',
  '  elixir      mix.exs -> `mix test`',
  '  terraform / opentofu   `terraform validate` / `tofu validate`, `tflint`, `terraform fmt -check`,',
  '              plus `terraform plan` where it runs without credentials or side effects',
  '  k8s/helm    `helm lint`, `kubeconform`, `kustomize build`',
  '  shell       `shellcheck`, `bats`',
  '  sql/dbt     `dbt build --empty`, `sqlfluff lint`',
  '  docs/config `markdownlint`, `yamllint`, JSON schema validation',
].join('\n')

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const RECON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['is_git_repo', 'head_sha', 'branch', 'is_trunk', 'dirty', 'ecosystem', 'verify_commands', 'has_executable_checks'],
  properties: {
    is_git_repo: { type: 'boolean', description: 'True only if `git rev-parse --is-inside-work-tree` succeeded.' },
    head_sha: { type: 'string', description: 'Full sha from `git rev-parse HEAD`, or empty if there are no commits yet.' },
    branch: { type: 'string', description: 'From `git rev-parse --abbrev-ref HEAD`.' },
    is_trunk: {
      type: 'boolean',
      description: 'True if the current branch is this repo\'s shared trunk. Determine it from the repo (origin/HEAD, the default branch, CI rules) — do not assume the name is main or master.',
    },
    dirty: { type: 'boolean', description: 'True if `git status --porcelain` printed anything, ignoring untracked files that .gitignore already covers.' },
    dirty_summary: { type: 'string', description: 'The porcelain output, trimmed, if dirty.' },
    ecosystem: { type: 'string', description: 'What this repo actually is, e.g. "python/pytest", "terraform+tflint", "go", "node/vitest", "mixed: terraform + python lambdas".' },
    verify_commands: {
      type: 'array',
      description: 'Every command that can FAIL and thereby prove something, most authoritative first. Empty array is a valid honest answer.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'command', 'source'],
        properties: {
          kind: { type: 'string', enum: ['test', 'lint', 'typecheck', 'build', 'validate', 'plan'] },
          command: { type: 'string', description: 'Exact, runnable from the repo root.' },
          source: { type: 'string', description: 'Where you got it — the file and line, or the CI job name. "Inferred" is acceptable but say so.' },
          verified_runs: { type: 'boolean', description: 'True only if you actually executed it and it completed (pass OR fail). False if you only read it somewhere.' },
        },
      },
    },
    primary_check_cmd: { type: 'string', description: 'The single command downstream agents should run. Prefer a real test suite; fall back to validate/lint/build. Empty if the repo genuinely has none.' },
    has_executable_checks: { type: 'boolean', description: 'True if at least one verify_command actually ran. This decides whether verification can execute or only read.' },
    layout_notes: { type: 'string', description: 'Where source, tests and config live; anything this repo does unusually that an implementer would otherwise trip over.' },
    conventions: { type: 'string', description: 'Stated conventions from CLAUDE.md / AGENTS.md / CONTRIBUTING.md worth passing on verbatim, including any worktree or commit-trailer rules.' },
    today: { type: 'string', description: 'Today\'s date as `date -I` prints it (YYYY-MM-DD). The engine cannot read a clock; documents are named with this.' },
    docs_layout: { type: 'string', description: 'Where this repo keeps specs and plans if it has a convention (e.g. "specs: docs/specs, plans: docs/plans, named YYYY-MM-DD-<slug>.md"), and how the last few were named; empty if it has none.' },
  },
}

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['shared_context', 'task_summary', 'slices'],
  properties: {
    shared_context: { type: 'string', description: 'What every implementer needs to know: conventions, where things live, the check command, anything the repo does unusually.' },
    task_summary: { type: 'string', description: 'At most ~250 words. What the task is for, EVERY hard constraint an implementer or patcher must obey (verbatim where the task states one), and the path of the authoritative spec/plan if there is one. Implementers and patchers are handed THIS instead of the full task text, so a constraint left out here is a constraint they never see.' },
    slices: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'prompt', 'files', 'done_when'],
        properties: {
          id: { type: 'string', description: 'Short stable id, e.g. s1' },
          title: { type: 'string' },
          prompt: { type: 'string', description: 'Self-contained instruction. The implementer sees this, shared_context and the task — nothing else.' },
          files: { type: 'array', items: { type: 'string' }, description: 'Every file this slice will create or modify. Repo-relative. Be complete: overlap here is what serialises slices.' },
          done_when: { type: 'string', description: 'The observable condition that means this slice is done.' },
        },
      },
    },
    uncovered: { type: 'array', items: { type: 'string' }, description: 'Any part of the task NOT covered by a slice, and why.' },
  },
}

const IMPL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['slice_results'],
  properties: {
    slice_results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'status', 'files_touched', 'notes'],
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: ['done', 'partial', 'failed'] },
          commit_sha: { type: 'string' },
          files_touched: { type: 'array', items: { type: 'string' } },
          checks_run: { type: 'string', description: 'The exact command(s) you ran, or empty if you ran none.' },
          checks_passed: { type: 'boolean' },
          notes: { type: 'string', description: 'Anything the verifier must know, including files you touched outside your declared set and why.' },
        },
      },
    },
  },
}

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verified', 'executed', 'summary', 'problems'],
  properties: {
    verified: { type: 'boolean' },
    executed: { type: 'boolean', description: 'True only if you ran the repo\'s check command yourself and saw it complete. Reading code is not executing.' },
    commands_run: { type: 'string', description: 'The exact command(s) you ran, newline-separated. Empty if you ran none.' },
    output_tail: { type: 'string', description: 'The real last ~20 lines of that output. Never reconstructed from memory.' },
    checks_available: { type: 'boolean', description: 'False if this repo genuinely has nothing executable to run — which is a fact about the repo, not a failure by the implementer.' },
    problems: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'what', 'evidence'],
        properties: {
          severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
          file: { type: 'string' },
          what: { type: 'string' },
          evidence: { type: 'string', description: 'The diff hunk or command output that shows it.' },
        },
      },
    },
    summary: { type: 'string' },
  },
}

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['clean', 'diff_reviewed', 'findings', 'summary'],
  properties: {
    clean: { type: 'boolean' },
    diff_reviewed: { type: 'boolean', description: 'True only if you actually ran the diff command and read the output.' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'severity', 'claim', 'failure_scenario'],
        properties: {
          id: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
          file: { type: 'string' },
          line: { type: 'integer' },
          claim: { type: 'string', description: 'One sentence: the defect.' },
          failure_scenario: { type: 'string', description: 'Concrete inputs/state -> wrong output or crash. "This is fragile" is not a finding.' },
          fix_hint: { type: 'string' },
        },
      },
    },
    summary: { type: 'string' },
  },
}

const PATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['finding_id', 'status', 'notes'],
  properties: {
    finding_id: { type: 'string' },
    status: { type: 'string', enum: ['fixed', 'disputed', 'failed'] },
    commit_sha: { type: 'string' },
    regression_test: { type: 'string', description: 'The test or check you added that fails before and passes after, or why none was possible in this repo.' },
    checks_passed: { type: 'boolean' },
    notes: { type: 'string', description: 'If disputed: the evidence that refutes the finding. Never dispute without evidence.' },
  },
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Run items through stages in waves of `size`, so at most `size` agents are
// ever live. Each wave is a barrier; within a wave, pipeline() means an item
// moves to stage 2 as soon as ITS stage 1 finishes.
async function waves(items, size, ...stages) {
  const out = []
  for (let i = 0; i < items.length; i += size) {
    const chunk = items.slice(i, i + size)
    if (items.length > size) {
      log('wave ' + (Math.floor(i / size) + 1) + '/' + Math.ceil(items.length / size) + ' (' + chunk.length + ' item(s))')
    }
    const got = await pipeline(chunk, ...stages)
    out.push(...got)
  }
  return out
}

// Run items through ONE stage in waves of `size`, at most `size` agents live.
// Used where the two stages cannot be pipelined per item: implement is
// serialised within a group, while verify is free to run flat out.
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

// Repo-relative paths for the same file arrive spelled differently ("./src/a.py",
// "src/a.py", "src\\a.py", "src/./a.py", "/src/a.py"). Conflict detection is
// exact-match on these strings, so an unnormalised pair reads as disjoint and two
// agents get sent at one file — the exact failure the grouping exists to prevent.
// Collapse separators BEFORE stripping "./", and strip a leading "/" as well:
// otherwise ".//src/a.py" lands on "/src/a.py" and silently misses "src/a.py".
function normPath(p) {
  let s = String(p || '').trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  let prev
  do {
    prev = s
    s = s.replace(/\/\.\//g, '/').replace(/^\.\//, '')
  } while (s !== prev)
  return s.replace(/^\/+/, '').replace(/\/+$/, '')
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
function declaredFiles(s) {
  const out = new Set()
  for (const raw of s.files || []) {
    for (const p of expandBraces(String(raw || ''))) {
      const f = normPath(p)
      if (!f) continue
      if (f.includes('*')) {
        log('WARNING: slice ' + s.id + ' declared a glob (' + f + ') — a glob cannot be proven disjoint')
      }
      out.add(f)
    }
  }
  return out
}

// Slices that touch a common file cannot run concurrently. Union them into a
// group; the group's slices run SEQUENTIALLY — one agent each, never merged
// into one context — and groups run in parallel. A slice with no declared
// files gets its own group and a warning, because an unknown footprint cannot
// be proven disjoint.
function groupByFileConflict(slices) {
  const groups = []
  for (const s of slices) {
    const files = declaredFiles(s)
    if (files.size === 0) {
      log('WARNING: slice ' + s.id + ' declared no files — running it alone, footprint unknown')
      groups.push({ slices: [s], files })
      continue
    }
    const hits = groups.filter((g) => [...files].some((f) => g.files.has(f)))
    if (hits.length === 0) {
      groups.push({ slices: [s], files })
      continue
    }
    const target = hits[0]
    target.slices.push(s)
    for (const f of files) target.files.add(f)
    for (const extra of hits.slice(1)) {
      target.slices.push(...extra.slices)
      for (const f of extra.files) target.files.add(f)
      const at = groups.indexOf(extra)
      if (at >= 0) groups.splice(at, 1)
    }
  }
  return groups
}

function sliceBlock(s) {
  return [
    '--- SLICE ' + s.id + ': ' + s.title,
    'what:      ' + s.prompt,
    'files:     ' + (s.files || []).join(', '),
    'done when: ' + s.done_when,
  ].join('\n')
}

function severityRank(sev) {
  if (sev === 'critical') return 0
  if (sev === 'major') return 1
  return 2
}


// ---------------------------------------------------------------------------
// Doctrine embedded per role. Copied from the superpowers skills (MIT, Jesse
// Vincent), adapted only where a stage has no human to ask: the spec writer
// must DECIDE and record instead of asking, and there is no approval gate.
// Embedded rather than invoked by name so the pair stays self-contained — an
// install without the plugin behaves identically.
// ---------------------------------------------------------------------------
const DOCTRINE_BRAINSTORM = "DOCTRINE FOR THIS STAGE (from the superpowers `brainstorming` skill, adapted for a run with no human to ask):\n\nHelp turn an idea into a fully formed design and spec. Classify the request first and say the\nclassification in the spec: a SPIKE (a feasibility question whose output is an answer, not code to\nkeep), a BOUNDED change (a well-scoped change to a flow that already exists in this repo \u2014 bounded\nmeasures the repo, not your familiarity with the kind of app), or ARCHITECTURAL (a new subsystem, a\nchange that restructures how components fit or alters interfaces others depend on). When in doubt,\ntake the heavier path; hidden complexity discovered mid-way upgrades the path, never downgrades it.\n\"Too simple to need a design\" is the thought that wastes the most work: simple means a short design,\nnot no design.\n\nUnderstanding the idea:\n- Check the current project state first: files, docs, recent commits, the conventions it states.\n- Assess scope before detail. If the request describes several independent subsystems, decompose:\n  name the independent pieces, how they relate, what order they should be built in, and write THIS\n  spec for the first sub-project only; list the rest under \"Out of scope, next specs\".\n- Focus on purpose, constraints, success criteria.\n- There is NO human partner in this run. Every question you would have asked, you must answer\n  yourself: pick the answer a careful colleague would pick, and record every such choice in a\n  section titled \"Decisions taken without the owner\", one row each \u2014 the question, the decision,\n  why \u2014 so the owner can overturn any of them by reading that one section. Never leave a TBD.\n\nExploring approaches:\n- Propose two or three approaches with trade-offs; lead with your recommendation and why.\n- YAGNI ruthlessly: remove unnecessary features from every approach and from the design.\n\nPresenting the design (in the spec):\n- Cover architecture, components, data flow, error handling, testing. Scale each section to its\n  complexity: a few sentences if straightforward, a few hundred words if nuanced.\n- Design for isolation and clarity: units with one purpose, well-defined interfaces, understandable\n  and testable independently. For each unit: what does it do, how do you use it, what does it depend on.\n- In an existing codebase, follow its patterns. Include targeted improvements only where an existing\n  problem affects THIS work; propose no unrelated refactoring.\n\nSpec self-review before you finish (fix inline, no re-review needed):\n1. Placeholder scan: any TBD, TODO, incomplete section or vague requirement \u2014 fix it.\n2. Internal consistency: do sections contradict each other; does the architecture match the features.\n3. Scope check: focused enough for one implementation plan, or does it need decomposition.\n4. Ambiguity check: could a requirement be read two ways \u2014 pick one and make it explicit.\n"
const DOCTRINE_WRITING_PLANS = "DOCTRINE FOR THIS STAGE (from the superpowers `writing-plans` skill):\n\nWrite a comprehensive implementation plan assuming the engineer has zero context for this codebase\nand questionable taste. Document everything they need: which files to touch for each task, the code,\nthe tests, the docs they might need to check, how to test it. Bite-sized tasks. DRY. YAGNI. TDD.\nFrequent commits. Assume a skilled developer who knows almost nothing about this toolset or problem\ndomain and does not know good test design well.\n\nScope check: if the spec covers several independent subsystems, the plan covers the first and says so.\n\nFile structure first: before defining tasks, map which files are created or modified and what each is\nresponsible for \u2014 this is where decomposition is locked in. Units with clear boundaries and interfaces;\nsmaller focused files over large ones; files that change together live together; in an existing\ncodebase follow its patterns.\n\nTask right-sizing: a task is the smallest unit that carries its own test cycle and is worth a fresh\nreviewer's gate. Fold setup, configuration, scaffolding and documentation into the task whose\ndeliverable needs them; split only where a reviewer could reject one task while approving its\nneighbour. Each task ends with an independently testable deliverable. Each STEP is one action of two\nto five minutes: write the failing test; run it and watch it fail; write the minimal implementation;\nrun it and watch it pass; commit.\n\nThe plan MUST start with this header:\n\n# [Feature Name] Implementation Plan\n\n> **For agentic workers:** this plan is executed by the verified-build engine, one task per slice,\n> each slice implemented by a fresh agent and verified by a different model. Steps use `- [ ]` syntax.\n\n**Goal:** [one sentence]\n**Architecture:** [two or three sentences]\n**Tech Stack:** [key technologies]\n**Spec:** [path \u2014 the plan argues from the spec, so the spec travels with it]\n\n## Global Constraints\n[The spec's project-wide requirements, one line each, exact values copied verbatim. Every task's\nrequirements implicitly include this section.]\n\nThen a \"## File map\" (created / modified / deleted, one line per file with its responsibility) and a\n\"## File-overlap table\" (for every file two or more tasks touch: the tasks, in order \u2014 the engine\nserialises those tasks, so keep chains short and prefer merging a chain longer than four into fewer,\nlarger tasks).\n\nEach task has this structure:\n\n### Task N: [Component Name]\n**Files:** Create / Modify (`exact/path.py:123-145`, measured with grep -n or sed -n on the CURRENT\ntree, never estimated) / Test.\n**Interfaces:** Consumes (what this task uses from earlier tasks \u2014 exact signatures) / Produces (what\nlater tasks rely on \u2014 exact names, parameter and return types; an implementer sees only its own task).\n- [ ] **Step 1: Write the failing test** \u2014 the real test code, in a fenced block.\n- [ ] **Step 2: Run it to verify it fails** \u2014 the exact command and the expected failure.\n- [ ] **Step 3: Write the minimal implementation** \u2014 the real code, in a fenced block.\n- [ ] **Step 4: Run it to verify it passes** \u2014 the exact command.\n- [ ] **Step 5: Run the repo's own check** and **commit** \u2014 the exact commit message in the repo's convention.\n\nNo placeholders. These are plan failures, never write them: \"TBD\", \"TODO\", \"implement later\", \"add\nappropriate error handling\", \"add validation\", \"handle edge cases\", \"write tests for the above\" without\nthe test code, \"similar to Task N\" (repeat the code), steps that describe without showing (code blocks\nare required for code steps), references to names not defined in any task.\n\nSelf-review after writing (fix inline, then stop):\n1. Spec coverage: every requirement in the spec points to a task that implements it; add tasks for gaps.\n2. Placeholder scan: search the plan for every pattern above.\n3. Type consistency: names, signatures and property names used in later tasks match what earlier\n   tasks defined.\n"
const DOCTRINE_TDD = "DOCTRINE (from the superpowers `test-driven-development` and `verification-before-completion` skills):\n\nThe iron law: NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST. Write one minimal test showing what\nshould happen; run it and WATCH IT FAIL, for the expected reason (feature missing, not a typo \u2014 a test\nthat passes immediately is testing existing behaviour, fix the test); write the simplest code that\npasses; run it and watch it pass with the other tests still green and the output pristine; refactor\nonly after green, adding no behaviour. Wrote code before the test? Delete it and start from the test.\nGood tests: one behaviour each, a name that describes the behaviour, real code rather than mocks\nunless a mock is unavoidable, asserting on behaviour rather than on the mock. Name, before writing a\ntest, the production change that would make it fail. Keep test-only code in test utilities, never in\nproduction classes. Where the repo's only checks are lint/validate/build, those are the red and green.\n\nEvidence before claims, always: NO COMPLETION CLAIM WITHOUT FRESH VERIFICATION EVIDENCE. Before you\nreport any status: identify the command that proves it, run the FULL command fresh, read the whole\noutput and the exit code, and only then make the claim \u2014 with the evidence. \"Should pass\", \"looks\ncorrect\", \"I'm confident\", a previous run, a partial run: none of these is evidence. A regression test\nis proven by red-green: it must fail on the old code and pass on the new. Requirements are met when you\nre-read the task, make a checklist, and verify each line, not when the tests pass.\n"
const DOCTRINE_DEBUG = "DOCTRINE (from the superpowers `systematic-debugging` skill, plus TDD and verification):\n\nNO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST. Phase 1, root cause: read the error and the finding's\nfailure_scenario completely; reproduce it (a failing test, or a one-off script if the repo has no test\nframework); check what changed recently (git log, git diff); in a multi-component path add evidence at\neach boundary and see WHERE it breaks; trace a bad value back to where it originates and fix at the\nsource, not the symptom. Phase 2, pattern: find working examples of the same shape in this codebase,\nread the reference completely, list every difference. Phase 3, hypothesis: state ONE specific hypothesis,\nmake the smallest change that tests it, one variable at a time; if it did not work form a new\nhypothesis rather than stacking fixes. Phase 4, implement: a failing test that reproduces the finding\nFIRST, then one fix at the root cause, no \"while I'm here\" improvements, no bundled refactoring; then\nverify \u2014 the new test passes, no other test broke, the scenario is actually resolved. If three fixes\nhave failed, stop: the pattern is architectural, report it as disputed-with-evidence rather than\nattempting a fourth. Under time pressure the process is faster than guessing, not slower.\n\nEvidence before claims, always: identify the command that proves the fix, run it in full, read the\noutput, and only then claim it. A regression test is proven by red-green: revert the fix and watch it\nfail, restore it and watch it pass.\n"
const DOCTRINE_REVIEW_CALIBRATION = "CALIBRATION (from the superpowers code-reviewer template): categorise by ACTUAL severity \u2014 not\neverything is critical. Be specific (file:line, not vague), explain WHY each issue matters and how to\nfix it if not obvious, and give a clear verdict. Never say \"looks good\" without checking, never mark a\nnitpick critical, never report on code you did not read, never be vague (\"improve error handling\"). If a\ndeviation from the plan looks intentional, say so as a deviation rather than a defect; if the plan\nitself is wrong, say that. Your review is read-only on this checkout: never mutate the working tree,\nthe index, HEAD or branch state; if you need another revision, use a separate `git worktree` in a\ntemporary directory. Do the whole review yourself: never spawn a subagent to review part of it.\n"
const DOCTRINE_RECEIVING = "DOCTRINE FOR FOLDING IN A REVIEW (from the superpowers `receiving-code-review` skill):\n\nReview feedback needs technical evaluation, not performance. For each finding: READ it completely;\nrestate the requirement in your own words; VERIFY it against the document and the codebase; EVALUATE\nwhether it is right for THIS repo; then RESPOND \u2014 fold it in, or refute it with technical reasoning and\nconcrete evidence (a command you ran, a line you read). Never fold in a finding you have not verified;\nnever refuse one merely because it is inconvenient. Push back when the finding breaks something that\nexists, lacks context the document states, violates YAGNI, or contradicts a decision the owner already\nrecorded \u2014 and in that last case leave the owner's decision standing and say why. Fold in one finding at\na time; keep the document consistent after each (a change in one section usually has echoes in the\nFile map, the overlap table, the self-review and the tests). No gratitude, no \"you're absolutely\nright\": state what changed. Record the disposition of every finding, folded or refuted, in a fold-in\nsection at the end of the document.\n"

const QUESTION_ITEMS = {
  type: 'array',
  description: 'Decisions the OWNER should make, not you. Escalate only when the choice affects money, risk, data, ownership, reverses something that exists, or careful colleagues would decide it differently. Everything else you decide and record.',
  items: {
    type: 'object', additionalProperties: false,
    required: ['id', 'question', 'options', 'recommended', 'why'],
    properties: {
      id: { type: 'string', description: 'Q1, Q2, … — unique within this document.' },
      question: { type: 'string', description: 'One sentence, in the owner\'s terms, ending in a question mark.' },
      options: {
        type: 'array', minItems: 2, maxItems: 4,
        items: {
          type: 'object', additionalProperties: false, required: ['label', 'consequence'],
          properties: {
            label: { type: 'string', description: 'Short: what the owner would pick.' },
            consequence: { type: 'string', description: 'What choosing it means, concretely, for scope, behaviour, data or cost.' },
          },
        },
      },
      recommended: { type: 'string', description: 'The label of the option you recommend. It is also the provisional decision written into the document, marked "pending owner".' },
      why: { type: 'string', description: 'Why you recommend it, in one or two sentences.' },
    },
  },
}

const SPEC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'slug', 'classification', 'title', 'summary', 'decisions', 'commit_sha'],
  properties: {
    path: { type: 'string', description: 'Repo-relative path of the spec file you wrote and committed.' },
    slug: { type: 'string', description: 'The kebab-case slug used in the file name, e.g. armable-plans-one-predicate.' },
    classification: { type: 'string', enum: ['spike', 'bounded', 'architectural'] },
    title: { type: 'string' },
    summary: { type: 'string', description: 'At most ~150 words: what the spec decides and why. The orchestrator reports this.' },
    decisions: {
      type: 'array',
      description: 'Every question you would have asked a human and answered yourself instead. The owner reads this list to overturn any of them.',
      items: {
        type: 'object', additionalProperties: false, required: ['question', 'decision', 'why'],
        properties: { question: { type: 'string' }, decision: { type: 'string' }, why: { type: 'string' } },
      },
    },
    out_of_scope: { type: 'array', items: { type: 'string' }, description: 'Sub-projects or requirements deliberately left for a later spec.' },
    open_questions: QUESTION_ITEMS,
    commit_sha: { type: 'string' },
  },
}

const DOC_REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'findings', 'summary'],
  properties: {
    status: { type: 'string', enum: ['approved', 'issues_found'] },
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'severity', 'where', 'claim', 'evidence', 'fix'],
        properties: {
          id: { type: 'string', description: 'F1, F2, …' },
          severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
          where: { type: 'string', description: 'The section, task or step the finding is about.' },
          claim: { type: 'string', description: 'What is wrong, specifically.' },
          evidence: { type: 'string', description: 'What you ran or read that shows it: a command and its output, a file:line, a contradiction quoted from the document.' },
          fix: { type: 'string', description: 'What the document should say instead.' },
        },
      },
    },
    recommendations: { type: 'array', items: { type: 'string' }, description: 'Advisory; never blocks.' },
    questions_for_owner: QUESTION_ITEMS,
    summary: { type: 'string' },
  },
}

const FOLD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['folded', 'refuted', 'commit_sha', 'summary'],
  properties: {
    folded: { type: 'array', items: { type: 'string' }, description: 'Finding ids you folded into the document.' },
    refuted: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'evidence'],
        properties: { id: { type: 'string' }, evidence: { type: 'string', description: 'The concrete evidence that refutes it.' } },
      },
    },
    commit_sha: { type: 'string', description: 'The commit that carries the fold-in; empty if nothing changed.' },
    summary: { type: 'string' },
  },
}

const PLANDOC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'title', 'tasks', 'commit_sha'],
  properties: {
    path: { type: 'string', description: 'Repo-relative path of the plan file you wrote and committed.' },
    title: { type: 'string' },
    tasks: {
      type: 'array', minItems: 1,
      description: 'One entry per "### Task N" section, in order, as the file now stands.',
      items: {
        type: 'object', additionalProperties: false, required: ['n', 'title', 'files', 'lines'],
        properties: {
          n: { type: 'integer' },
          title: { type: 'string' },
          files: { type: 'array', items: { type: 'string' }, description: 'Every file the task creates or modifies, repo-relative.' },
          lines: { type: 'string', description: 'The task section\'s line range in the plan file, e.g. "94-492", measured with grep -n after your last edit.' },
        },
      },
    },
    global_constraints_lines: { type: 'string', description: 'Line range of the "## Global Constraints" section, e.g. "25-39".' },
    commit_sha: { type: 'string' },
  },
}

// ---------------------------------------------------------------------------
// Phase 0 — Recon. Establishes, ONCE, the three things that used to be either
// assumed or rediscovered N times: that this is a safe git repo to commit into,
// what the repo is, and the exact command that proves the work. Doing it once
// is both cheaper and more consistent — N agents guessing a test command
// independently is N chances to disagree about what "passing" means.
// ---------------------------------------------------------------------------
phase('Recon')
log('task: ' + TASK.slice(0, 160))

const recon = await callAgent(
  [
    'You are RECON. You write no code and make no commits. Establish the ground truth the rest of this run depends on.',
    '',
    'The task that is about to be implemented here, for context only — do NOT start it:',
    TASK,
    '',
    '1. GIT STATE. Run these and report exactly what they say:',
    '   `git rev-parse --is-inside-work-tree`, `git rev-parse HEAD`,',
    '   `git rev-parse --abbrev-ref HEAD`, `git status --porcelain`',
    '   For is_trunk, work out this repo\'s ACTUAL shared trunk rather than assuming a name —',
    '   `git symbolic-ref refs/remotes/origin/HEAD` is the usual answer, and CI config or',
    '   CLAUDE.md may name a different protected branch (some repos protect `develop`, some',
    '   deploy from `main` and develop on `dev`).',
    '',
    '2. WHAT THIS REPO IS. Not every repo is an application with unit tests. It may be',
    '   Terraform/OpenTofu, Helm charts, shell, SQL, docs, or several of those at once.',
    '   Say what it actually is in `ecosystem`.',
    '',
    '3. HOW IT VERIFIES ITSELF. Find every command that can FAIL and thereby prove',
    '   something, and RUN each one to confirm it works in this environment before you',
    '   report it. Look here:',
    DISCOVERY_HINTS,
    '',
    '   Set `verified_runs` true only for commands you actually executed. A command that',
    '   needs credentials, network or a running service you do not have is still worth',
    '   reporting — mark verified_runs false and say why in `source`.',
    '   Set `primary_check_cmd` to the one command downstream agents should run: prefer a',
    '   real test suite, else validate/lint/build. If the repo genuinely has nothing',
    '   executable, return an empty string and has_executable_checks:false. That is an',
    '   honest and useful answer — do NOT invent a plausible-looking command.',
    '',
    '4. LAYOUT AND CONVENTIONS. Read CLAUDE.md / AGENTS.md / CONTRIBUTING.md / README.',
    '   Capture anything an implementer would otherwise waste three tool calls rediscovering,',
    '   and quote any hard rules verbatim — especially worktree requirements, commit message',
    '   or trailer rules, and files that must not be touched.',
    '',
    '5. DATE AND DOCUMENTS. Run `date -I` and report it as `today`. Look for where this repo keeps',
    '   design specs and implementation plans (docs/specs, docs/plans, docs/superpowers/…, a docs/',
    '   README) and how the most recent ones are named; report that in `docs_layout`, or empty.',
  ].join('\n'),
  { label: 'recon', phase: 'Recon', model: CODER, effort: EFFORT, schema: RECON_SCHEMA }
)

if (!recon) {
  return { ok: false, stage: 'recon', error: 'recon agent returned nothing; cannot establish repo state' }
}
if (recon.is_git_repo !== true) {
  return {
    ok: false,
    stage: 'recon',
    error: 'not a git repository. Every lane here commits and diffs, so a repo is required. Run `git init` and make a first commit, or launch from inside the repo.',
    recon: recon,
  }
}
if (!String(recon.head_sha || '').trim()) {
  return {
    ok: false,
    stage: 'recon',
    error: 'repo has no commits yet, so there is no base to diff against. Make an initial commit first.',
    recon: recon,
  }
}
if (recon.dirty === true && !ALLOW_DIRTY) {
  return {
    ok: false,
    stage: 'recon',
    error: 'working tree is dirty. Several agents commit concurrently and the adversary reviews the combined diff, so pre-existing changes would be attributed to this run. Commit or stash first, or pass allowDirty:true if the changes are genuinely part of the task.',
    dirty_summary: recon.dirty_summary || '',
    recon: recon,
  }
}
if (recon.is_trunk === true && !ALLOW_TRUNK) {
  return {
    ok: false,
    stage: 'recon',
    error: 'refusing to run on `' + (recon.branch || '?') + '`, which this repo treats as its shared trunk. Several agents commit concurrently; that must not land on a trunk. Create a branch (or a worktree) and relaunch, or pass allowTrunk:true.',
    recon: recon,
  }
}

const BASE = String(recon.head_sha).trim()
const CHECK_CMD = TEST_CMD || String(recon.primary_check_cmd || '').trim()
const HAS_CHECKS = Boolean(CHECK_CMD) && recon.has_executable_checks !== false

const TEST_LINE = CHECK_CMD
  ? 'The command that proves this repo still works is: ' + CHECK_CMD +
  (TEST_CMD ? ' (supplied by the caller — prefer it over anything you discover).' : ' (found by recon; if it is wrong, say so rather than silently substituting your own).')
  : 'Recon found NOTHING executable in this repo (' + (recon.ecosystem || 'unknown ecosystem') + '). Do not invent a command. ' +
  'Verification here is necessarily read-only: say so plainly instead of implying you ran something.'

log('repo: ' + (recon.ecosystem || 'unknown') + ' on ' + (recon.branch || '?') +
  ' @ ' + BASE.slice(0, 8) + (HAS_CHECKS ? ' | check: ' + CHECK_CMD : ' | NO EXECUTABLE CHECKS'))
if (!HAS_CHECKS) {
  log('WARNING: nothing executable to run. Verification degrades to reading the diff; ' +
    'treat a clean verdict as weaker evidence than usual.')
}
if (Array.isArray(recon.verify_commands) && recon.verify_commands.length > 1) {
  log('other checks available: ' + recon.verify_commands.slice(1).map((c) => c.kind + '=' + c.command).join(' | '))
}


// ---------------------------------------------------------------------------
// The documents. Today's date and the docs layout come from Recon (the engine
// has no clock). A document writer WRITES and COMMITS its file; a reviewer is
// read-only and returns findings with evidence; a fold-in agent judges each
// finding, edits the document, commits, and returns what it folded and what it
// refuted. One review round per document by default (docRounds).
// ---------------------------------------------------------------------------
const TODAY = /^\d{4}-\d{2}-\d{2}$/.test(String(recon.today || '')) ? String(recon.today) : 'undated'
const DOCS_LAYOUT = String(recon.docs_layout || '').trim()
const SPEC_DIR = SPEC_DIR_IN || (/(docs\/[\w./-]*specs)/.exec(DOCS_LAYOUT) || [null, 'docs/specs'])[1]
const PLANS_DIR = PLANS_DIR_IN || (/(docs\/[\w./-]*plans)/.exec(DOCS_LAYOUT) || [null, 'docs/plans'])[1]
const COMMIT_RULES = 'Commit in this repo\'s own convention' + (recon.conventions ? ' (its stated conventions: ' + recon.conventions.slice(0, 1500) + ')' : '') + '. Do NOT push.'

const documents = { from: FROM, spec: null, spec_reviews: [], plan: null, plan_reviews: [], decisions: [], questions: [], answers: ANSWERS }
// Declared here, before the helpers that read them, so a pause at the spec stage can
// report both without tripping over a `let` further down that has not run yet.
let SPEC_PATH = SPEC_PATH_IN || (FROM === 'spec' && looksLikePath(TASK) ? TASK.trim() : '')
let PLAN_PATH = PLAN_PATH_IN || (FROM === 'plan' && looksLikePath(TASK) ? TASK.trim() : '')
let planDoc = null

function looksLikePath(t) {
  return /^[\w./-]+\.md$/.test(t.trim()) && !/\s/.test(t.trim())
}

// Questions are namespaced by stage ("spec:Q1") so an answer given for the spec's
// pause is never mistaken for a plan question of the same local id, and so the
// apply-answers prompt for the spec stays byte-identical across a later resume.
function namespaced(stage, qs) {
  const seen = new Set()
  const out = []
  for (const q of qs || []) {
    if (!q || !q.id) continue
    const id = stage + ':' + String(q.id).replace(/^\w+:/, '')
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ ...q, id })
  }
  return out
}

function answersFor(stage) {
  return ANSWERS.filter((a) => a.id.startsWith(stage + ':') && a.answer.trim())
}

// Returns null to continue, or the early-return object when the run must pause.
function ownerGate(stage, questions, docPath) {
  const answered = new Set(answersFor(stage).map((a) => a.id))
  const open = questions.filter((q) => !answered.has(q.id))
  documents.questions.push(...questions.map((q) => ({ ...q, answered: answered.has(q.id) })))
  if (!open.length) return null
  if (!PAUSE_FOR_OWNER) {
    log(stage + ': ' + open.length + ' owner question(s) left to the recommended option (pauseForOwner:false): ' +
      open.map((q) => q.id + ' -> ' + q.recommended).join(', '))
    documents.decisions.push(...open.map((q) => ({
      stage: stage, question: q.question, decision: q.recommended + ' (recommended option, owner not asked)', why: q.why,
    })))
    return null
  }
  log('PAUSED at the ' + stage + ' stage: ' + open.length + ' question(s) for the owner — ' + open.map((q) => q.id).join(', '))
  return {
    ok: true,
    paused: true,
    stage: stage,
    questions: open,
    document: docPath,
    how_to_resume: 'Ask the user each question (recommended option first), then relaunch this workflow with the SAME script ' +
      'and resumeFromRunId, and args identical except `answers`: [{id, answer}] for every question above ' +
      '(keep earlier answers too). Every agent before this pause replays from cache.',
    answers_so_far: ANSWERS,
    documents: { ...documents, spec_path: SPEC_PATH || null, plan_path: PLAN_PATH || null },
    recon: recon,
  }
}

async function applyAnswers(stage, docPath, questions) {
  const given = answersFor(stage)
  if (!given.length) return null
  const byId = Object.fromEntries(questions.map((q) => [q.id, q]))
  const applied = await callAgent(
    [
      'You are the AUTHOR recording the OWNER\'S ANSWERS in your ' + stage + ': ' + docPath,
      '',
      'THE OWNER ANSWERED THESE QUESTIONS (the owner outranks every reviewer and every provisional decision):',
      JSON.stringify(given.map((a) => ({ id: a.id, question: (byId[a.id] || {}).question || '', answer: a.answer,
        options: (byId[a.id] || {}).options || [] })), null, 2),
      '',
      'DO THIS:',
      '- For each answer, find the provisional decision marked "pending owner" and REPLACE it with the owner\'s',
      '  decision, attributed to the owner. Where the owner picked a listed option, apply that option\'s',
      '  consequence throughout the document (scope, behaviour, data, tests, out-of-scope lists). Where the',
      '  owner wrote something else, treat it as the decision and reshape the affected sections to match.',
      '- Keep the document whole and consistent afterwards; no placeholder may survive.',
      '- Record every answer in the "Decisions taken without the owner" table\'s neighbour: a table titled',
      '  "Decisions taken by the owner" (question, decision, date ' + TODAY + ').',
      '- ' + COMMIT_RULES,
    ].join('\n'),
    { label: stage + '-answers', phase: stage === 'spec' ? 'Spec review' : 'Plan review', model: JUDGE, effort: EFFORT, schema: FOLD_SCHEMA }
  )
  documents.decisions.push(...given.map((a) => ({
    stage: stage, question: (byId[a.id] || {}).question || a.id, decision: a.answer, why: 'the owner\'s answer',
  })))
  return applied
}

async function reviewAndFold(kind, docPath, extra) {
  // kind: 'spec' | 'plan'. Returns the list of {review, fold} rounds.
  const out = []
  for (let r = 1; r <= DOC_ROUNDS; r++) {
    phase(kind === 'spec' ? 'Spec review' : 'Plan review')
    const review = await callAgent(
      [
        'You are the ADVERSARIAL REVIEWER of a ' + (kind === 'spec' ? 'design spec' : 'implementation plan') +
        '. Your job is to REFUTE the claim that it is complete, consistent and ready for the next stage.',
        'A clean verdict you cannot defend is worse than a false alarm; a finding without evidence is noise.',
        '',
        'THE DOCUMENT: ' + docPath + ' — read it whole.',
        (extra || ''),
        '',
        'THE REPO: ' + (recon.ecosystem || 'unknown') + (HAS_CHECKS ? '. Check command: ' + CHECK_CMD : '. No executable checks.'),
        (recon.conventions ? 'Conventions it documents, which a violation of IS a finding:\n' + recon.conventions : ''),
        '',
        (kind === 'spec'
          ? [
            'WHAT TO CHECK (the superpowers spec reviewer, sharpened):',
            '- Completeness: TODOs, placeholders, TBDs, incomplete sections, a decision the document dodges.',
            '- Consistency: internal contradictions, conflicting requirements, an architecture that does not match the features.',
            '- Clarity: a requirement ambiguous enough that someone would build the wrong thing.',
            '- Scope: focused enough for ONE plan; unrequested features; over-engineering (YAGNI).',
            '- Reality: does the spec\'s account of the CURRENT code match the tree? Open the files it names and',
            '  check every claim about them. A spec built on a wrong reading of the code produces a wrong plan.',
            '- The "Decisions taken without the owner" section: is every decision there defensible, and is',
            '  any decision hidden elsewhere in the text without being listed?',
            'Calibration: flag only what would cause a flawed plan. Wording, style and "less detailed than',
            'other sections" are not findings.',
          ].join('\n')
          : [
            'WHAT TO CHECK (the superpowers plan reviewer, sharpened by what plan reviews caught this week):',
            '- Completeness: TODOs, placeholders, incomplete tasks, missing steps, "similar to Task N".',
            '- Spec alignment: every spec requirement maps to a task; no major scope creep; every "Global',
            '  Constraint" copied verbatim from the spec.',
            '- Buildability against the REAL tree — this is where plan reviews earn their keep:',
            '    * every `Modify: path:lines` range: open the file and check the range holds the code the task edits;',
            '    * every fenced code block: parse/compile it where the language allows (`python -m py_compile`,',
            '      `node --check`, `tofu validate` …); a block shown in context may need a wrapper — say which;',
            '    * every test the plan gives: do the fixtures, helpers and imports it uses exist? would its',
            '      Step 2 really fail red, and its Step 4 really go green?',
            '    * every Consumes/Produces signature: does the name defined in one task match its use in another?',
            '    * the file-overlap table: does it match every task\'s Files list? are the chains short?',
            '  Where it is cheap, splice a task into a scratch `git worktree` (a temporary directory, never this',
            '  checkout) and run its own commands. That is the strongest evidence a plan review can produce.',
            '- Task decomposition: clear boundaries; steps actionable; a test cycle per task.',
            '- Sequencing: tasks in an order where each one\'s Consumes already exists.',
            'Calibration: flag only what would cause an implementer to build the wrong thing or get stuck.',
          ].join('\n')),
        '',
        DOCTRINE_REVIEW_CALIBRATION,
        'RULES:',
        '- Every finding carries EVIDENCE: the command you ran and what it printed, the file:line you read, the',
        '  two sentences that contradict each other. Under uncertainty, raise it — a false positive costs one',
        '  fold-in agent; a false negative costs a build.',
        '- status "approved" ONLY if you read the whole document and found nothing meeting that bar.',
        '- A decision the document took that the OWNER should make (money, risk, data, ownership, a reversal',
        '  of something that exists, a choice careful colleagues would make differently) is not a finding —',
        '  put it in `questions_for_owner` with options, consequences and your recommendation. The run pauses',
        '  and asks. Do not raise a question the document already lists as one.',
        '- You do not edit the document. You do not commit.',
        (r > 1 ? '\nThis is review round ' + r + '; the fold-in of round ' + (r - 1) + ' is already in the file.' : ''),
      ].join('\n'),
      { label: kind + '-review:r' + r, phase: kind === 'spec' ? 'Spec review' : 'Plan review', model: JUDGE, effort: EFFORT, schema: DOC_REVIEW_SCHEMA }
    )
    if (!review) { out.push({ round: r, review: null, fold: null }); break }
    log(kind + ' review round ' + r + ': ' + review.status + ', ' + review.findings.length + ' finding(s)')
    if (review.status === 'approved' || review.findings.length === 0) { out.push({ round: r, review, fold: null }); break }

    const fold = await callAgent(
      [
        'You are the AUTHOR folding an adversarial review into your ' + (kind === 'spec' ? 'spec' : 'plan') + '.',
        '',
        'THE DOCUMENT: ' + docPath,
        (extra || ''),
        '',
        'THE FINDINGS:',
        JSON.stringify(review.findings, null, 2),
        (review.recommendations && review.recommendations.length ? '\nADVISORY (fold in only if clearly right): ' + review.recommendations.join(' | ') : ''),
        '',
        DOCTRINE_RECEIVING,
        'RULES:',
        '- Verify each finding against the document and the tree before you act on it. Fold in the ones that',
        '  hold; refute the ones that do not, with the concrete evidence, and leave the text as it was.',
        '- The owner\'s recorded decisions (' + (kind === 'spec' ? 'the "Decisions taken without the owner" section' : 'the spec\'s decisions, which the plan must not silently reverse') + ')',
        '  outrank a reviewer. A finding that would reverse one is refuted on that ground, and reported.',
        '- Keep the document whole and consistent after every fold-in: file map, overlap table, self-review,',
        '  line ranges (re-measure them), test names. No placeholders may appear as a result of a fold-in.',
        '- Append a "## Fold-in record (review round ' + r + ')" section: a table of every finding id, verdict',
        '  (folded / refuted) and what changed or why not.',
        '- ' + COMMIT_RULES,
      ].join('\n'),
      { label: kind + '-fold:r' + r, phase: kind === 'spec' ? 'Spec review' : 'Plan review', model: JUDGE, effort: EFFORT, schema: FOLD_SCHEMA }
    )
    out.push({ round: r, review, fold })
    if (!fold) break
    log(kind + ' fold-in round ' + r + ': ' + fold.folded.length + ' folded, ' + fold.refuted.length + ' refuted')
  }
  return out
}

// ----- Spec ---------------------------------------------------------------
if (FROM === 'idea') {
  phase('Spec')
  const spec = await callAgent(
    [
      'You are the SPEC WRITER. Turn the idea below into a design spec, write it to a file, and commit it.',
      'You write no implementation code.',
      '',
      'THE IDEA:',
      TASK,
      '',
      'THE REPO: ' + (recon.ecosystem || 'unknown') + ' on branch ' + (recon.branch || '?') + '.',
      (recon.layout_notes ? 'Layout: ' + recon.layout_notes : ''),
      (recon.conventions ? 'Conventions (binding): ' + recon.conventions : ''),
      (DOCS_LAYOUT ? 'Documents convention: ' + DOCS_LAYOUT : ''),
      '',
      DOCTRINE_BRAINSTORM,
      'OUTPUT:',
      '- Write the spec to `' + SPEC_DIR + '/' + TODAY + '-<slug>.md` (follow the repo\'s naming where it has one).',
      '- Structure it so a plan can be written from it alone: the problem and the evidence for it in the',
      '  current code (cite files and lines you actually read), the decisions, the required behaviour with',
      '  numbered sections, the claims a test can make, the effect on existing data, risks, out of scope, and',
      '  the "Decisions taken without the owner" table.',
      '- Any constraint from the repo (principles in CLAUDE.md, module budgets, one-writer rules, channel',
      '  rules) that this work touches is restated in the spec, verbatim, as a hard constraint.',
      '- QUESTIONS FOR THE OWNER: the doctrine above says decide and record. One exception. When a choice',
      '  affects money, risk, data, ownership, reverses something that exists, or is one careful colleagues',
      '  would make differently, do NOT decide it silently: put it in `open_questions` with two to four',
      '  options, the consequence of each, and your recommendation with its reason; write the recommended',
      '  option into the spec as the provisional decision, marked "pending owner", so the document is',
      '  complete either way. The run will pause and ask the owner. Everything below that bar, decide.',
      '- ' + COMMIT_RULES,
    ].join('\n'),
    { label: 'spec', phase: 'Spec', model: JUDGE, effort: EFFORT, schema: SPEC_SCHEMA }
  )
  if (!spec) return { ok: false, stage: 'spec', error: 'the spec writer returned nothing', recon }
  SPEC_PATH = spec.path
  documents.spec = spec
  documents.decisions.push(...(spec.decisions || []).map((d) => ({ stage: 'spec', ...d })))
  log('spec: ' + spec.path + ' (' + spec.classification + ', ' + (spec.decisions || []).length + ' decision(s) taken without the owner)')
  documents.spec_reviews = await reviewAndFold('spec', SPEC_PATH, 'THE IDEA IT CAME FROM:\n' + TASK)
  const specQuestions = namespaced('spec', [
    ...(spec.open_questions || []),
    ...documents.spec_reviews.flatMap((r) => (r.review && r.review.questions_for_owner) || []),
  ])
  const pause = ownerGate('spec', specQuestions, SPEC_PATH)
  if (pause) return pause
  const applied = await applyAnswers('spec', SPEC_PATH, specQuestions)
  if (applied) log('spec: owner answers recorded (' + (applied.commit_sha || 'no commit') + ')')
}

// ----- Plan ---------------------------------------------------------------
if (FROM === 'idea' || FROM === 'spec') {
  phase('Plan')
  const specRef = SPEC_PATH ? 'THE SPEC: ' + SPEC_PATH + ' — read it whole; the plan argues from it.' : 'THE SPEC (inline):\n' + TASK
  planDoc = await callAgent(
    [
      'You are the PLAN WRITER. Write the implementation plan for the spec below, to a file, and commit it.',
      'You write no implementation code — but every code block the plan gives must be real, complete code,',
      'measured against the CURRENT tree.',
      '',
      specRef,
      (answersFor('spec').length
        ? '\nTHE OWNER\'S ANSWERS to the spec\'s questions (binding; already folded into the spec):\n' +
          JSON.stringify(answersFor('spec'), null, 2)
        : ''),
      '',
      'THE REPO: ' + (recon.ecosystem || 'unknown') + ' on branch ' + (recon.branch || '?') + '.',
      (HAS_CHECKS ? 'Check command: ' + CHECK_CMD : 'No executable checks — say so in Global Constraints.'),
      (recon.layout_notes ? 'Layout: ' + recon.layout_notes : ''),
      (recon.conventions ? 'Conventions (binding): ' + recon.conventions : ''),
      (DOCS_LAYOUT ? 'Documents convention: ' + DOCS_LAYOUT : ''),
      '',
      DOCTRINE_WRITING_PLANS,
      'HOW THIS PLAN WILL BE EXECUTED, which shapes it:',
      '- One task = one slice = one fresh implementer agent that reads ONLY its task section, the Global',
      '  Constraints and a short shared context. So a task must be complete in itself: files with measured',
      '  line ranges, exact Consumes/Produces, the failing test as real code, the implementation as real code,',
      '  the exact commands, the commit message.',
      '- Tasks that touch a common file run one after another. Keep such chains at four or fewer; merge',
      '  where a chain would be longer. Prefer tasks that are file-disjoint.',
      '- A different model re-runs the repo\'s check on every commit and reads the real diff; a third pass',
      '  attacks the whole. Write the plan so those judges have something exact to hold the work to.',
      '',
      'OUTPUT:',
      '- Write to `' + PLANS_DIR + '/' + TODAY + '-<slug>.md`' + (SPEC_PATH ? ' (same slug as the spec).' : '.'),
      '- ' + COMMIT_RULES,
      '- Report every task with its files and its line range in the file AFTER your final edit (grep -n).',
    ].join('\n'),
    { label: 'plan-doc', phase: 'Plan', model: JUDGE, effort: EFFORT, schema: PLANDOC_SCHEMA }
  )
  if (!planDoc) return { ok: false, stage: 'plan', error: 'the plan writer returned nothing', recon, documents }
  PLAN_PATH = planDoc.path
  documents.plan = planDoc
  log('plan: ' + planDoc.path + ' (' + planDoc.tasks.length + ' task(s))')
  documents.plan_reviews = await reviewAndFold('plan', PLAN_PATH, (SPEC_PATH ? 'THE SPEC IT IMPLEMENTS: ' + SPEC_PATH : 'THE REQUIREMENTS:\n' + TASK))
  const planQuestions = namespaced('plan', documents.plan_reviews.flatMap((r) => (r.review && r.review.questions_for_owner) || []))
  const pausePlan = ownerGate('plan', planQuestions, PLAN_PATH)
  if (pausePlan) return pausePlan
  const appliedPlan = await applyAnswers('plan', PLAN_PATH, planQuestions)
  if (appliedPlan) log('plan: owner answers recorded (' + (appliedPlan.commit_sha || 'no commit') + ')')
  // Line ranges move under a fold-in; re-measure them for the slicer.
  const folded = documents.plan_reviews.some((r) => r.fold && r.fold.commit_sha) || Boolean(appliedPlan && appliedPlan.commit_sha)
  if (folded) {
    const remeasured = await callAgent(
      [
        'Read ' + PLAN_PATH + ' as it stands NOW and report every "### Task N" section in order with its files',
        'and its line range (grep -n "^### Task" and "^## Global Constraints"; the range ends where the next',
        'section starts). Report the commit_sha as `git rev-parse HEAD`. Do not edit anything.',
      ].join('\n'),
      { label: 'plan-index', phase: 'Plan review', model: CODER, effort: 'low', schema: PLANDOC_SCHEMA }
    )
    if (remeasured) { planDoc = remeasured; documents.plan = remeasured }
  }
}

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
    TASK,
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
    'after the other instead of at the same time. They each keep their own agent and their own verifier, so the',
    'only thing overlap costs is wall-clock. Declare `files` completely and accurately — under-declaring causes',
    'two agents to edit one file at once, which is the failure mode this whole structure exists to prevent.',
    'Over-declaring costs you time; under-declaring costs you the work.',
    '',
    'Slices that share a file run one after another. If overlap would force MORE THAN FOUR slices into one serial',
    'chain, MERGE adjacent members of that chain into fewer, larger slices (a merged slice still gets one agent',
    'and one verifier). Every serialised slice pays a fixed cost — a cold agent reading the repo and its spec — so',
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
    'silently drop scope — an honest gap is useful, a hidden one is not.',
    '',
    'Write no code. Make no commits.',
  ].join('\n'),
  { label: 'plan', phase: 'Plan', model: JUDGE, effort: EFFORT, schema: PLAN_SCHEMA }
)

if (!plan || !plan.slices || !plan.slices.length) {
  return { ok: false, stage: 'plan', error: 'planner returned no slices', plan, recon: recon }
}

const SHARED = String(plan.shared_context || '')
// What implementers and patchers see instead of the full task: every agent that carried
// the whole brief re-read it on every turn (plan C: 53 agents, a 4,200-line plan each).
// Verifiers and the adversary keep the full TASK — it is the bar, and they are the judges.
const TASK_BRIEF = String(plan.task_summary || '').trim() || TASK
// Two-dot: literally "everything added between BASE and HEAD". Three-dot would
// route through merge-base, which is identical while history stays linear and
// quietly different the moment it does not.
const DIFF_CMD = 'git diff ' + BASE + '..HEAD'

if (plan.uncovered && plan.uncovered.length) {
  log('planner left uncovered: ' + plan.uncovered.join(' | '))
}

const groups = groupByFileConflict(plan.slices)
const biggestGroup = groups.reduce((n, g) => Math.max(n, g.slices.length), 0)
log(plan.slices.length + ' slice(s) -> ' + groups.length + ' conflict-free group(s) (largest holds ' +
  biggestGroup + '), up to ' + WAVE + ' group(s) at a time')
if (groups.length === 1 && plan.slices.length > 2) {
  log('WARNING: all ' + plan.slices.length + ' slices merged into ONE group — their declared files overlap ' +
    'transitively, so nothing can run concurrently. Each slice still gets its own agent and its own ' +
    'verifier; this run will be slow, not large.')
}

// ---------------------------------------------------------------------------
// Phase 2 — Implement. ONE AGENT PER SLICE, always. A group means "these run in
// order", not "these share a context": file-disjointness governs concurrency and
// nothing else. Merging N slices into one agent is how a run ends up with a
// single 600k-token context and no verification until the very end.
// ---------------------------------------------------------------------------
phase('Implement')

function implPrompt(s, landedSiblings) {
  return [
    'You are the IMPLEMENTER. Write the code for the ONE slice below and commit it.',
    '',
    'THE TASK IN BRIEF (context — do NOT implement any of it beyond your slice; obey every constraint in it):',
    TASK_BRIEF,
    '',
    'SHARED CONTEXT:',
    SHARED,
    '',
    'YOUR SLICE — this is the whole of your job:',
    sliceBlock(s),
    '',
    (landedSiblings.length
      ? 'Slices touching your files have ALREADY landed ahead of you in this run: ' +
      landedSiblings.map((d) => d.slice.id + ' (' + d.slice.title + ')').join(', ') +
      '.\nTheir work is in the tree. Build on it; do not revisit, revert or re-do it.\n'
      : ''),
    DOCTRINE_TDD,
    'RULES:',
    '- Implement this slice and nothing else. Return exactly one entry in slice_results.',
    '- Touch only the files your slice declares. If you genuinely must touch another, do it and SAY SO in notes.',
    '- Follow the repo\'s own conventions. Read its CLAUDE.md / AGENTS.md first if it has one.',
    '- ' + TEST_LINE,
    (HAS_CHECKS
      ? '- Where the repo has a real test suite, write the test first, watch it fail, then make it pass. Where its\n' +
      '  only checks are lint/validate/build, run those instead — the point is that something executes and can fail.\n' +
      '- Run that command before you commit, and report it in checks_run / checks_passed.'
      : '- There is nothing executable to run here, so do NOT claim you ran anything: leave checks_run empty and\n' +
      '  checks_passed false. Compensate by keeping the commit small and self-evident in the diff, since a\n' +
      '  reviewer reading it is the only gate this work will get.'),
    '- Commit with a clear message.',
    '- Do NOT push. Do NOT merge or rebase branches. Do NOT amend commits you did not make.',
    '- If the slice defeats you, commit what is genuinely correct and report it as partial or failed.',
    '',
    'Another model that did not write this code will verify it against the real diff and re-run whatever this',
    'repo can run. Claiming a check passed when you did not run it will be caught, so report exactly what you',
    'ran and exactly what happened.',
  ].join('\n')
}

// A group's slices are serialised because they share files. Each still gets a
// fresh agent, so context stays bounded by the slice, not by the group.
async function implementGroup(group) {
  const landed = []
  for (const s of group.slices) {
    const impl = await callAgent(implPrompt(s, landed), {
      label: 'impl:' + s.id,
      phase: 'Implement',
      model: CODER,
      effort: EFFORT,
      schema: IMPL_SCHEMA,
    })
    landed.push({ slice: s, impl: impl })
  }
  return landed
}

const built = (await wavesOne(groups, WAVE, implementGroup, 'implement wave')).filter(Boolean).flat()

// ---------------------------------------------------------------------------
// Phase 3 — Verify. Read-only, so there is no file contention and the grouping
// is irrelevant here: every slice gets its own verifier reading its own commits.
// ---------------------------------------------------------------------------
phase('Verify')

const results = (await wavesOne(
  built,
  WAVE,
  (prev) =>
    callAgent(
      [
        'You are the VERIFIER. You did not write this code and you do not trust the report below.',
        '',
        'OVERALL TASK:',
        TASK,
        '',
        'WHAT WAS SUPPOSED TO HAPPEN:',
        sliceBlock(prev.slice),
        '',
        'WHAT THE IMPLEMENTER CLAIMS:',
        JSON.stringify(prev.impl, null, 2),
        '',
        'DO THIS, IN ORDER:',
        '1. For every commit sha claimed, run `git show --stat <sha>` and `git show <sha>`. A sha that does not',
        '   exist, or a commit whose diff does not match its message, is verified:false on its own.',
        '2. Read the diff. Does it do what the slice said, or something merely adjacent to it?',
        '3. ' + (HAS_CHECKS
          ? 'Run the check YOURSELF. ' + TEST_LINE + ' Paste the real tail into output_tail and set executed:true.'
          : 'There is nothing executable in this repo. ' + TEST_LINE + ' Set executed:false and checks_available:false,'
          + ' and review the diff as carefully as you would if it were the only evidence — because it is.'),
        '4. Look specifically for: files touched outside the declared set; tests or checks weakened, skipped or',
        '   deleted to make things pass; TODO stubs standing in for the work; commented-out assertions; except/catch',
        '   blocks that swallow the error the check was supposed to surface; a value hardcoded where it should be derived.',
        '',
        DOCTRINE_REVIEW_CALIBRATION,
        'RULES:',
        '- Judge THIS slice only. Other slices in this run have their own verifiers; a defect that is plainly',
        '  outside your slice belongs in problems as minor, not as a verdict on work you were not given.',
        (HAS_CHECKS
          ? '- verified:true REQUIRES that you ran the check and saw it pass. A read-only review is verified:false\n' +
          '  with a problem of "not executed". Never infer a result.\n' +
          '- If you could not run it (broken env, missing credentials), say so plainly and return verified:false.'
          : '- This repo has no executable checks, so verified:true here means ONLY "the diff does what the slice said\n' +
          '  and I found no defect in it". Set checks_available:false and say in summary that nothing was executed.\n' +
          '  Do not withhold verification merely because tests do not exist — but do not overstate it either.'),
        '- You report. You do not fix, and you do not commit.',
      ].join('\n'),
      { label: 'verify:' + prev.slice.id, phase: 'Verify', model: JUDGE, effort: EFFORT, schema: VERIFY_SCHEMA }
    ).then((v) => ({ ...prev, verify: v })),
  'verify wave'
)).filter(Boolean)

const failedVerify = results.filter((r) => !r.verify || r.verify.verified !== true)
log('implemented ' + built.length + '/' + plan.slices.length + ' slice(s); ' +
  failedVerify.length + ' of ' + results.length + ' failed verification')

// ---------------------------------------------------------------------------
// Phase 4 — Adversarial review. BARRIER: the adversary needs the whole diff.
// ---------------------------------------------------------------------------
function reviewPrompt(roundLabel, extra) {
  return [
    'You are the ADVERSARIAL REVIEWER. Your job is to REFUTE the claim that this work is complete and correct.',
    'You are not here to be reassuring, and a clean verdict you cannot defend is worse than a false alarm.',
    '',
    'OVERALL TASK — this is the bar the work must clear:',
    TASK,
    '',
    (PLAN_PATH ? 'THE PLAN DOCUMENT THE WORK MUST MATCH, task by task: ' + PLAN_PATH + (SPEC_PATH ? ' (spec: ' + SPEC_PATH + ')' : '') : ''),
    'THE SLICES THAT WERE EXECUTED:',
    JSON.stringify(plan.slices.map((s) => ({ id: s.id, title: s.title, done_when: s.done_when })), null, 2),
    (plan.uncovered && plan.uncovered.length ? '\nThe planner already admitted leaving out: ' + plan.uncovered.join(' | ') : ''),
    '',
    'PER-SLICE VERIFICATION RESULTS:',
    JSON.stringify(results.map((r) => ({ slice: r.slice.id, verify: r.verify })), null, 2),
    '',
    (extra || ''),
    'READ THE ACTUAL DIFF YOURSELF — do not review the reports:',
    '  ' + DIFF_CMD,
    'Set diff_reviewed:true only if you ran that and read the output.',
    '',
    'THE REPO YOU ARE REVIEWING: ' + (recon.ecosystem || 'unknown') +
    (HAS_CHECKS ? '. Its check command is: ' + CHECK_CMD : '. It has NO executable checks.'),
    (recon.conventions ? 'Conventions it documents, which a violation of IS a finding:\n' + recon.conventions : ''),
    '',
    'HUNT SPECIFICALLY FOR:',
    '- Requirements in the task that NO slice implemented. The gap the plan itself missed is the finding the',
    '  per-slice verifiers structurally cannot see, and it is the main reason you exist.',
    '- Integration seams: an assumption slice A relies on that slice B quietly changed.',
    '- Behaviour the diff changes that no test or check covers.',
    '- Edge and error paths: empty, null, zero, negative, very large, unicode, concurrent, partial failure.',
    '- Anything a verifier marked verified:true that the diff does not actually support.',
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
      : '- Nothing here was executed, so you are the only gate. Weigh the diff accordingly and say so in summary.'),
    '- Every finding needs a concrete failure_scenario: specific inputs or state leading to a specific wrong',
    '  result. "This is fragile", "consider extracting", "could be clearer" are NOT findings — drop them.',
    '- Style, naming and formatting are not findings unless the repo\'s own documented convention is violated.',
    '- clean:true ONLY if you read the whole diff and found nothing meeting that bar. Say so in summary.',
    '- You review. You do not fix, and you do not commit.',
    (roundLabel ? '\nThis is ' + roundLabel + '.' : ''),
  ].join('\n')
}

phase('Review')
let review = await callAgent(reviewPrompt('the first review', ''), {
  label: 'adversary:r0',
  phase: 'Review',
  model: JUDGE,
  effort: EFFORT,
  schema: REVIEW_SCHEMA,
})

// ---------------------------------------------------------------------------
// Phase 5 — Patch rounds. Stops the moment a review comes back clean.
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
  if (budget.total && budget.remaining() < 60000) {
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

  // Patchers used to run all at once in the shared tree, one per finding, and the
  // verifiers kept meeting sibling patchers' uncommitted edits. Same cure as the
  // implement phase: findings that name the same file run one after another, groups
  // run in parallel, and every patch still gets its own verifier — those run as soon
  // as their patch lands, in parallel across the round.
  const patchGroups = groupByFileConflict(take.map((f) => ({ id: f.id, files: f.file ? [f.file] : [], finding: f })))
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
          '- Stage and commit ONLY the files you edited, by name (`git add <file>`), never `git add -A`: other',
          '  patchers may be working in this tree on other files. Commit with a message naming the finding id. Do NOT push.',
          '- If you believe the finding is WRONG, do not quietly skip it and do not "fix" it anyway: return',
          '  status "disputed" with the concrete evidence that refutes it. An unevidenced dispute will be',
          '  treated as a failure.',
        ].join('\n'),
      { label: 'patch:' + f.id, phase: 'Patch', model: CODER, effort: EFFORT, schema: PATCH_SCHEMA }
    ).then((p) => ({ finding: f, patch: p }))
  }

  function verifyOne(prev) {
    return callAgent(
        [
          'You are the VERIFIER for one patch. You did not write it.',
          '',
          'THE FINDING IT CLAIMS TO CLOSE:',
          JSON.stringify(prev.finding, null, 2),
          '',
          'WHAT THE PATCHER CLAIMS:',
          JSON.stringify(prev.patch, null, 2),
          '',
          'DO THIS:',
          '1. `git show <commit_sha>`. Read the real diff.',
          '2. Decide whether it actually closes the failure_scenario, or merely makes the symptom go away.',
          '3. Check the regression test genuinely exercises the scenario — a test that would pass on the OLD',
          '   code proves nothing. Say so if you believe it would.',
          '4. ' + (HAS_CHECKS
            ? 'Run the check yourself. ' + TEST_LINE + ' Paste the real output tail and set executed:true.'
            : TEST_LINE + ' Set executed:false and checks_available:false; judge the patch on the diff alone.'),
          '5. Check the patch broke nothing adjacent.',
          '',
          'If the patcher DISPUTED the finding, judge the evidence: say plainly whether the dispute holds.',
          (HAS_CHECKS
            ? 'verified:true requires that you ran the check and saw it pass.'
            : 'Nothing is executable here, so verified:true means only that the diff genuinely closes the finding.'),
          'You do not fix, and you do not commit.',
        ].join('\n'),
      { label: 'verify:' + prev.finding.id, phase: 'Patch', model: JUDGE, effort: EFFORT, schema: VERIFY_SCHEMA }
    ).then((v) => ({ ...prev, verify: v }))
  }

  async function patchGroup(group) {
    const verifies = []
    for (const item of group.slices) {
      const p = await patchOne(item.finding)
      if (p) verifies.push(verifyOne(p))
    }
    return parallel(verifies.map((v) => () => v))
  }

  const patched = (await wavesOne(patchGroups, WAVE, patchGroup, 'patch wave')).filter(Boolean).flat()

  const done = patched.filter(Boolean)
  rounds.push({ round: round, patched: done, deferred: deferred, handed_off: handedOff })
  log('round ' + round + ': ' + done.filter((p) => p.patch && p.patch.status === 'fixed').length + ' fixed, ' +
    done.filter((p) => p.patch && p.patch.status === 'disputed').length + ' disputed, ' +
    done.filter((p) => !p.patch || p.patch.status === 'failed').length + ' failed')

  phase('Review')
  review = await callAgent(
    reviewPrompt(
      'review round ' + round + ' of at most ' + MAX_ROUNDS,
      [
        'PATCHES APPLIED SINCE THE LAST REVIEW:',
        JSON.stringify(done.map((p) => ({ finding_id: p.finding.id, claim: p.finding.claim, patch: p.patch, verify: p.verify })), null, 2),
        (deferred.length ? 'DEFERRED, NOT PATCHED: ' + deferred.map((f) => f.id + ' (' + f.claim + ')').join(' | ') : ''),
        '',
        'Two jobs this round, and the second is the one people forget:',
        '(a) Is each finding above GENUINELY closed? A patch that moves the symptom is not a fix. Re-raise it if not.',
        '(b) Did the patches themselves introduce anything new? Patch rounds are written under time pressure and',
        '    are a common source of fresh defects. Review their diffs as adversarially as the original work.',
        'A finding the patcher disputed with sound evidence should NOT be re-raised — say so in summary instead.',
        '',
      ].join('\n')
    ),
    { label: 'adversary:r' + round, phase: 'Review', model: JUDGE, effort: EFFORT, schema: REVIEW_SCHEMA }
  )
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const openFindings = review && Array.isArray(review.findings) && review.clean !== true ? review.findings : []
const stoppedEarly = round >= MAX_ROUNDS && openFindings.length > 0

// Everything the orchestrator must close by hand, at EVERY severity: what the last
// review left standing, plus every finding a round handed off (below PATCH_SEVERITY)
// or deferred (past the per-round cap), unless a later review explicitly re-raised
// it under the same id (then it is already in openFindings) — a later review that
// simply did not mention a handed-off minor has not closed it. Sorted critical first.
const forOrchestrator = []
const seenIds = new Set()
for (const f of openFindings) {
  if (f && f.id && !seenIds.has(f.id)) { seenIds.add(f.id); forOrchestrator.push({ ...f, source: 'final review' }) }
}
for (const r of rounds) {
  for (const f of [...(r.handed_off || []), ...(r.deferred || [])]) {
    if (f && f.id && !seenIds.has(f.id)) {
      seenIds.add(f.id)
      forOrchestrator.push({ ...f, source: (r.handed_off || []).includes(f) ? 'handed off in round ' + r.round : 'deferred in round ' + r.round })
    }
  }
}
forOrchestrator.sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
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

return {
  ok: true,
  task: TASK,
  base_sha: BASE,
  diff_command: DIFF_CMD,
  repo: {
    ecosystem: recon.ecosystem || '',
    branch: recon.branch || '',
    check_command: CHECK_CMD || null,
    // The honest caveat: false means no lane in this run executed anything, so
    // every "verified" below rests on reading alone. Report it, do not bury it.
    executable_checks: HAS_CHECKS,
    other_checks: (recon.verify_commands || []).slice(1),
  },
  paused: false,
  patch_policy: { max_rounds: MAX_ROUNDS, auto_patch_at_or_above: PATCH_SEVERITY },
  // The front half: where the run started, the documents it wrote and committed, every
  // adversarial review and fold-in of them, and — first thing to report — every decision a
  // writer took because there was no owner to ask.
  documents: { ...documents, spec_path: SPEC_PATH || null, plan_path: PLAN_PATH || null, doc_rounds: DOC_ROUNDS, pause_for_owner: PAUSE_FOR_OWNER },
  models: {
    implement: CODER, verify: JUDGE, review: JUDGE, effort: EFFORT, max_concurrent: WAVE,
    // Lanes whose primary model returned nothing and were re-run once on the other
    // tier. A verdict from a fallback lane is still a verdict, but say which model gave it.
    fallbacks: { enabled: FALLBACK, coder: CODER_FALLBACK, judge: JUDGE_FALLBACK, used: fallbacksUsed },
  },
  plan: { slices: plan.slices, groups: groups.length, largest_group: biggestGroup, uncovered: plan.uncovered || [] },
  implementation: results.map((r) => ({
    slice: r.slice.id,
    impl: r.impl,
    verified: r.verify ? r.verify.verified : null,
    problems: r.verify ? r.verify.problems : null,
  })),
  failed_verification: failedVerify.map((r) => r.slice.id),
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

export const meta = {
  name: 'build-verify-patch',
  description: 'Sonnet implements in waves of 15, Opus verifies every commit, Opus adversarially reviews the combined diff, then one patch round for critical/major findings',
  whenToUse: 'A multi-file feature, refactor, migration or non-trivial bugfix where you want the code written cheaply, verified by a model that did not write it, and attacked before you trust it. Works on any git repo in any language. Overkill for a one-line fix.',
  phases: [
    { title: 'Recon', detail: 'sonnet reads the repo: git state, ecosystem, how it verifies itself', model: 'sonnet' },
    { title: 'Plan', detail: 'opus splits the task into file-disjoint slices', model: 'opus' },
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
// Phase 1 — Plan
// ---------------------------------------------------------------------------
phase('Plan')

const plan = await callAgent(
  [
    'You are the PLANNER. You do not write the implementation — you split it so that several implementers can work at once without colliding.',
    '',
    'TASK:',
    TASK,
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
    '2. Split the task into at most ' + MAX_SLICES + ' slices.',
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
    'THE PLAN THAT WAS EXECUTED:',
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
  patch_policy: { max_rounds: MAX_ROUNDS, auto_patch_at_or_above: PATCH_SEVERITY },
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

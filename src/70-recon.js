// ---------------------------------------------------------------------------
// Probe and Recon: the two lanes that run before anything is designed or built.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Probe. One trivial, tool-free call per primary model. An API-key account may
// have an alias disabled for its organisation; a subscription may sit on a plan
// without one of the tiers. Either way the run must learn it here, for cents,
// not after Recon and a spec have been paid for. No fallback: the point is to
// know whether the PRIMARY works. Cached on resume like every other call.
// ---------------------------------------------------------------------------
if (PROBE_MODELS) {
  phase('Probe')
  const probeModels = PRIMARY_MODELS
  const probes = await parallel(probeModels.map((m) => () =>
    agent('Answer with the structured output ok:true. Use no tools, read nothing, run nothing.',
      { label: 'probe:' + m, phase: 'Probe', model: m, effort: 'low', schema: PROBE_SCHEMA })
      .catch((e) => ({ error: String(e.message || e).slice(0, 160) }))))
  const dead = probeModels.filter((m, i) => !probes[i] || probes[i].ok !== true)
  if (dead.length) {
    const detail = probeModels.map((m, i) => m + ': ' + (probes[i] && probes[i].ok === true ? 'ok' : (probes[i] && probes[i].error) || 'returned nothing'))
    log('PROBE FAILED — ' + detail.join(', '))
    return {
      ok: false,
      stage: 'probe',
      error: 'model(s) not usable from this session: ' + dead.join(', ') + '. On an API-key account, check that the model ' +
        'is enabled for the organisation (console.anthropic.com → Settings → Limits/Models) and that ANTHROPIC_API_KEY is the right ' +
        'key; on a subscription, that the plan includes it. Nothing was spent beyond these probes. Pass probeModels:false to skip.',
      probes: Object.fromEntries(probeModels.map((m, i) => [m, probes[i]])),
    }
  }
  log('probe: ' + probeModels.join(' and ') + ' answered')
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
// Recon. Establishes, ONCE, the three things that used to be either assumed or
// rediscovered N times: that this is a safe git repo to commit into, what the
// repo is, and the exact command that proves the work. Doing it once is both
// cheaper and more consistent — N agents guessing a test command independently
// is N chances to disagree about what "passing" means.
// ---------------------------------------------------------------------------
phase('Recon')
log('task: ' + TASK.slice(0, 160))

const recon = await callAgent(
  [
    'You are RECON. You write no code and make no commits. Establish the ground truth the rest of this run depends on.',
    '',
    'The task that is about to be implemented here, for context only — do NOT start it:',
    TASK_TEXT,
    '',
    '0. TOOLS. Run `git --version`. If git is missing, report is_git_repo:false and say so in dirty_summary.',
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
    '3. HOW IT VERIFIES ITSELF. Find every command that can FAIL and thereby prove something. Look here:',
    DISCOVERY_HINTS,
    '',
    '   RUN EXACTLY ONE of them: the one you will name `primary_check_cmd`. Choose the FASTEST command that',
    '   genuinely proves something — a smoke or quick target over the full suite, a real test run over',
    '   validate/lint/build. Run it in the foreground under `timeout 180`; if it does not finish in that time,',
    '   it is not the primary: report it with verified_runs false and "too slow for the run" in `source`, and',
    '   pick a faster one. Every other command is reported with verified_runs false, unexecuted. Never start a',
    '   check in the background, never poll a process, never inspect why a test run is slow: that is not your',
    '   job, and the run you are the first agent of pays for every minute you spend on it. (Measured: a recon',
    '   that ran the full suite and babysat it took 7 minutes and 67 tool calls; the number was never used.)',
    '   A command that needs credentials, network or a running service you do not have is still worth',
    '   reporting — verified_runs false and say why in `source`. If the repo genuinely has nothing',
    '   executable, return an empty string and has_executable_checks:false. That is an honest and useful',
    '   answer — do NOT invent a plausible-looking command.',
    '',
    '4. LAYOUT AND CONVENTIONS. Read CLAUDE.md / AGENTS.md / CONTRIBUTING.md / README.',
    '   Capture anything an implementer would otherwise waste three tool calls rediscovering,',
    '   and quote any hard rules verbatim — especially worktree requirements, commit message',
    '   or trailer rules, and files that must not be touched.',
    '',
    '5. DATE AND DOCUMENTS. Run `date -I` and report it as `today`. Look for where this repo keeps',
    '   design specs and implementation plans (docs/specs, docs/plans, docs/superpowers/…, a docs/',
    '   README) and how the most recent ones are named; report that in `docs_layout`, or empty.',
    (FROM === 'idea'
      ? [
        '',
        '6. WHERE THE TASK LANDS, AND WHAT THE OWNER MUST DECIDE. The task above is an idea; a spec',
        '   writer reads your answer next and starts from it instead of rediscovering the repo.',
        '   `touchpoints`: grep for the names, routes, tables, flags and modules the idea mentions and',
        '   list the files it will have to read or change — the entry point it extends, the module it',
        '   changes, the tests that cover it, the config it reads, and any SECOND caller or UI the',
        '   change must reach — each with a line range measured with `grep -n` and one line on why it',
        '   matters. Five to fifteen entries, measured on the current tree, never guessed; empty only',
        '   when the idea is genuinely greenfield.',
        '   `owner_questions`: the questions a careful colleague would put to the owner BEFORE',
        '   designing this — only where a choice affects money, risk, data, ownership, reverses',
        '   something that exists, or is one careful colleagues would make differently. Two to four',
        '   options each, the consequence of each, your recommendation and why. The engine asks the',
        '   owner before the spec is written. Most ideas have zero or one such question; never ask',
        '   what the idea already states, and never ask what a careful colleague would decide alone.',
      ].join('\n')
      : ''),
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
    error: 'not a git repository (or git is not installed — recon ran `git --version`; see dirty_summary). Every lane here commits and diffs, so a repo is required. Run `git init` and make a first commit, or launch from inside the repo.',
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
// An explicit testCmd always wins, including over Recon's has_executable_checks:false —
// the caller said it runs, and the adversary will find out if it does not.
const HAS_CHECKS = TEST_CMD ? true : Boolean(CHECK_CMD) && recon.has_executable_checks !== false

const TEST_LINE = CHECK_CMD
  ? 'The command that proves this repo still works is: ' + CHECK_CMD +
  (TEST_CMD ? ' (supplied by the caller — prefer it over anything you discover).' : ' (found by recon; if it is wrong, say so rather than silently substituting your own).')
  : 'Recon found NOTHING executable in this repo (' + (recon.ecosystem || 'unknown ecosystem') + '). Do not invent a command. ' +
  'Verification here is necessarily read-only: say so plainly instead of implying you ran something.'

log('repo: ' + (recon.ecosystem || 'unknown') + ' on ' + (recon.branch || '?') +
  ' @ ' + BASE.slice(0, 8) + (HAS_CHECKS ? ' | check: ' + CHECK_CMD : ' | NO EXECUTABLE CHECKS'))
if (!HAS_CHECKS) {
  log('WARNING: nothing executable to run. Review degrades to reading the diff; ' +
    'treat a clean verdict as weaker evidence than usual.')
}
if (Array.isArray(recon.verify_commands) && recon.verify_commands.length > 1) {
  log('other checks available: ' + recon.verify_commands.slice(1).map((c) => c.kind + '=' + c.command).join(' | '))
}

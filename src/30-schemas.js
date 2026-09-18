// ---------------------------------------------------------------------------
// Schemas. The structured output every lane must return; the runtime retries a
// reply that does not match. Field descriptions are read by the model, so they
// are instructions as much as documentation.
// ---------------------------------------------------------------------------
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

const RECON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['is_git_repo', 'head_sha', 'branch', 'is_trunk', 'dirty', 'ecosystem', 'verify_commands', 'has_executable_checks', 'today'],
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
    // Required, with a pattern: the first live run of the front half had Recon omit it
    // (it was optional), the engine fell back to 'undated', and the plan writer named
    // its file `docs/plans/undated-<slug>.md`. The runtime retries a schema mismatch.
    today: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Today\'s date exactly as `date -I` prints it (YYYY-MM-DD). Run the command; do not guess. The engine cannot read a clock; documents are named with this.' },
    docs_layout: { type: 'string', description: 'Where this repo keeps specs and plans if it has a convention (e.g. "specs: docs/specs, plans: docs/plans, named YYYY-MM-DD-<slug>.md"), and how the last few were named; empty if it has none.' },
    // Both only when the run starts from an idea. The spec writer used to rediscover where
    // the idea lands, and the owner's questions used to surface only after the spec and
    // its review — asked here, the writer writes with the answers in hand.
    touchpoints: {
      type: 'array',
      description: 'Where the task lands in the CURRENT tree: the files (with line ranges measured by grep -n, never estimated) the spec will have to read or change, and why each matters. Five to fifteen entries; empty when the task is genuinely greenfield or is a finished document.',
      items: {
        type: 'object', additionalProperties: false, required: ['path', 'lines', 'why'],
        properties: {
          path: { type: 'string', description: 'Repo-relative.' },
          lines: { type: 'string', description: 'e.g. "120-164"; empty when the whole file matters.' },
          why: { type: 'string', description: 'One line: the entry point the idea extends, the module it changes, the test that covers it, the config it reads, the second caller that must not be forgotten.' },
        },
      },
    },
    owner_questions: QUESTION_ITEMS,
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
    uncovered: { type: 'array', items: { type: 'string' }, description: 'ONLY task scope that no slice delivers, one entry per dropped item, with why. Empty when everything is covered. Never a note, a caveat or a statement that nothing was dropped: any entry here makes the run not ok.' },
    notes: { type: 'array', items: { type: 'string' }, description: 'Anything else the orchestrator should know: cross-slice dependencies no file overlap serialises, what the task itself puts outside every slice (a deploy, a final full-suite run), how tasks were merged. Informational only.' },
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
          notes: { type: 'string', description: 'Anything the reviewer must know, including files you touched outside your declared set and why.' },
        },
      },
    },
  },
}

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['clean', 'diff_reviewed', 'executed', 'findings', 'summary'],
  properties: {
    clean: { type: 'boolean' },
    diff_reviewed: { type: 'boolean', description: 'True only if you actually ran the diff command and read the output.' },
    executed: { type: 'boolean', description: 'True only if you ran the repo\'s check command yourself and saw it complete. Reading code is not executing.' },
    commands_run: { type: 'string', description: 'The exact command(s) you ran, newline-separated. Empty if you ran none.' },
    output_tail: { type: 'string', description: 'The real last ~20 lines of the check\'s output. Never reconstructed from memory.' },
    checks_available: { type: 'boolean', description: 'False if this repo genuinely has nothing executable to run — a fact about the repo, not a failure by the implementers.' },
    dirty_paths: { type: 'string', description: 'The output of `git status --porcelain`, verbatim. Empty if the tree was clean. Anything uncommitted here is work the diff you reviewed does not contain.' },
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
          files: { type: 'array', items: { type: 'string' }, description: 'Every file a fix would touch, INCLUDING the test file the regression test goes in. Patchers are serialised by this; leaving it out lets two patchers edit one file at once.' },
          line: { type: 'integer' },
          claim: { type: 'string', description: 'One sentence: the defect.' },
          failure_scenario: { type: 'string', description: 'Concrete inputs/state -> wrong output or crash. "This is fragile" is not a finding.' },
          fix_hint: { type: 'string' },
          re_raises: { type: 'string', description: 'Only in a re-review: the id of the EARLIER finding this one re-raises because its patch did not close it (e.g. "r0:F2"). Omit for a new finding.' },
        },
      },
    },
    summary: { type: 'string' },
  },
}

const PROBE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok'],
  properties: { ok: { type: 'boolean' } },
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

// One lane reviews the document adversarially AND folds its own findings in. It used to be
// two Opus agents (reviewer, then a fold-in author who could refute); measured on
// 2026-09-11 the fold-ins were 16 of 92 front-half minutes, a second cold read of the
// same document and repo, and refuted 0 of 17 findings. A finding the reviewer decides
// does not hold on verification is `withdrawn`, with the evidence, instead of folded.
const DOC_REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'findings', 'commit_sha', 'summary'],
  properties: {
    status: { type: 'string', enum: ['approved', 'issues_found'] },
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'severity', 'where', 'claim', 'evidence', 'fix', 'disposition', 'changed'],
        properties: {
          id: { type: 'string', description: 'F1, F2, …' },
          severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
          where: { type: 'string', description: 'The section, task or step the finding is about.' },
          claim: { type: 'string', description: 'What is wrong, specifically.' },
          evidence: { type: 'string', description: 'What you ran or read that shows it: a command and its output, a file:line, a contradiction quoted from the document.' },
          fix: { type: 'string', description: 'What the document should say instead.' },
          disposition: { type: 'string', enum: ['folded', 'withdrawn'], description: 'folded: you changed the document accordingly. withdrawn: on verification the finding did not hold, or it would reverse a recorded owner decision — say which in `changed`.' },
          changed: { type: 'string', description: 'What you changed in the document for this finding, or why it was withdrawn.' },
        },
      },
    },
    recommendations: { type: 'array', items: { type: 'string' }, description: 'Advisory; never blocks.' },
    questions_for_owner: QUESTION_ITEMS,
    commit_sha: { type: 'string', description: 'The NEW commit that carries your edits to the document (fold-ins and the fold-in record); empty only when there are no findings.' },
    document_diff_stat: { type: 'string', description: 'The output of `git show --stat <commit_sha> -- <the document>`, pasted verbatim; it must list the document. Empty only when there are no findings.' },
    summary: { type: 'string' },
  },
}

// The editor sent after a reviewer whose findings never reached the file.
const EDIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['applied', 'commit_sha', 'document_diff_stat', 'summary'],
  properties: {
    applied: { type: 'array', items: { type: 'string' }, description: 'Finding ids whose fix is now in the document.' },
    commit_sha: { type: 'string', description: 'The new commit that carries the edits.' },
    document_diff_stat: { type: 'string', description: 'The output of `git show --stat <commit_sha> -- <the document>`, pasted verbatim.' },
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
    open_questions: QUESTION_ITEMS,
    decisions: {
      type: 'array',
      description: 'Every decision the PLAN took that the spec left open or that narrows/sequences the spec (a declared narrowing, a migration number, an ordering, a file boundary). Empty only if the plan took none.',
      items: {
        type: 'object', additionalProperties: false, required: ['question', 'decision', 'why'],
        properties: { question: { type: 'string' }, decision: { type: 'string' }, why: { type: 'string' } },
      },
    },
    commit_sha: { type: 'string' },
  },
}

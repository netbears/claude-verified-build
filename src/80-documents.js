// ---------------------------------------------------------------------------
// The documents. Today's date and the docs layout come from Recon (the engine
// has no clock). A document writer WRITES and COMMITS its file; a reviewer is
// read-only and returns findings with evidence; a fold-in agent judges each
// finding, edits the document, commits, and returns what it folded and what it
// refuted. One review round per document by default (docRounds).
// ---------------------------------------------------------------------------
const TODAY = /^\d{4}-\d{2}-\d{2}$/.test(String(recon.today || '')) ? String(recon.today) : 'undated'
if (TODAY === 'undated') log('WARNING: recon did not report today\'s date; documents will be named undated-<slug>.md — rename them before merging')
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
let planReindexed = false

// The runtime phase a document lane reports under.
function docPhase(kind) {
  return kind === 'spec' ? 'Spec review' : 'Plan review'
}

// The documents block every early return and the final report carry.
function documentsReport() {
  return { ...documents, spec_path: SPEC_PATH || null, plan_path: PLAN_PATH || null }
}

// Told to both document writers when the run will not pause for the owner.
const OWNER_NOT_ASKED_NOTE = PAUSE_FOR_OWNER ? '' : '- THE OWNER WILL NOT BE ASKED in this run (pauseForOwner:false). Still list such questions in\n' +
  '  `open_questions` with your recommendation, but write the recommended option into the document as the\n' +
  '  decision, marked "(recommended option; owner not asked)" — never "pending owner".'

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
    documents: documentsReport(),
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
    { label: stage + '-answers', phase: docPhase(stage), model: DOC_JUDGE, effort: EFFORT, schema: FOLD_SCHEMA }
  )
  // The owner's answer goes on the record only once an author has written it into the
  // document; an author that returned nothing leaves "pending owner" in the text, and
  // claiming the decision recorded would be the lie the record exists to prevent.
  if (!applied) return false
  documents.decisions.push(...given.map((a) => ({
    stage: stage, question: (byId[a.id] || {}).question || a.id, decision: a.answer, why: 'the owner\'s answer',
  })))
  return applied
}

function answersLost(stage, docPath) {
  return { ok: false, stage: stage, error: 'the author recording the owner\'s answers in the ' + stage + ' returned nothing after its fallback; ' +
    docPath + ' still carries the provisional decisions marked "pending owner". Relaunch with the same answers.',
    recon, documents: documentsReport(), lane_errors: laneErrors }
}

// A document review round whose reviewer or fold-in author returned nothing is a gate
// that never ran. The build must not proceed on a document nobody attacked (or on
// findings nobody folded in), so the run stops here; a relaunch replays what ran.
function docLaneLost(kind, rounds) {
  const lost = rounds.find((r) => r.lost)
  if (!lost) return null
  const what = lost.why
    ? 'the ' + kind + ' review of round ' + lost.round + ' never reached the document: ' + lost.why + '; '
    : 'the ' + kind + ' ' + lost.lost + ' of round ' + lost.round + ' returned nothing after its fallback; '
  return { ok: false, stage: kind + '-review', error: what +
    'the ' + kind + ' is committed but ' + (lost.lost === 'reviewer' ? 'unreviewed' : 'its review is not folded in') + '. Nothing was sliced or implemented. Relaunch to retry.',
    recon, documents: documentsReport(), lane_errors: laneErrors }
}

async function reviewAndFold(kind, docPath, extra, writerSha) {
  // kind: 'spec' | 'plan'. Returns the list of {review, fold, edit} rounds; `fold` is derived
  // from the same agent's dispositions so the consumers keep their shape.
  const out = []
  let priorSha = String(writerSha || '')
  for (let r = 1; r <= DOC_ROUNDS; r++) {
    phase(docPhase(kind))
    const review = await callAgent(
      [
        'You are the ADVERSARIAL REVIEWER of a ' + (kind === 'spec' ? 'design spec' : 'implementation plan') +
        ', and then its EDITOR. First refute the claim that it is complete, consistent and ready for the next',
        'stage; then EDIT THE DOCUMENT YOURSELF to fold in what held, and commit. Findings you only list are not',
        'a review: the next stage reads the file, not your report. A clean verdict you cannot defend is worse',
        'than a false alarm; a finding without evidence is noise.',
        '',
        'THE DOCUMENT: ' + docPath + ' — read it whole.',
        (extra || ''),
        '',
        'THE REPO: ' + (recon.ecosystem || 'unknown') + (HAS_CHECKS ? '. Check command: ' + CHECK_CMD : '. No executable checks.'),
        (recon.conventions ? 'Conventions it documents, which a violation of IS a finding:\n' + recon.conventions : ''),
        '',
        (kind === 'spec'
          ? [
            'PART 1 — REVIEW. WHAT TO CHECK (the superpowers spec reviewer, sharpened):',
            '- Completeness: TODOs, placeholders, TBDs, incomplete sections, a decision the document dodges.',
            '- Consistency: internal contradictions, conflicting requirements, an architecture that does not match the features.',
            '- Clarity: a requirement ambiguous enough that someone would build the wrong thing.',
            '- Scope: focused enough for ONE plan; unrequested features; over-engineering (YAGNI); and the other',
            '  direction — a place the change must reach that the spec forgot (a second UI, a second caller, a report).',
            '- Reality: does the spec\'s account of the CURRENT code match the tree? Open the files it names and',
            '  check every claim about them. A spec built on a wrong reading of the code produces a wrong plan.',
            '- The "Decisions taken without the owner" section: is every decision there defensible, and is',
            '  any decision hidden elsewhere in the text without being listed?',
            'Calibration: flag only what would cause a flawed plan. Wording, style and "less detailed than',
            'other sections" are not findings.',
          ].join('\n')
          : [
            'PART 1 — REVIEW. WHAT TO CHECK (the superpowers plan reviewer, sharpened by what plan reviews caught):',
            '- Completeness: TODOs, placeholders, incomplete tasks, missing steps, "similar to Task N".',
            '- Spec alignment: every spec requirement maps to a task; no major scope creep; every "Global',
            '  Constraint" copied verbatim from the spec.',
            '- Buildability against the REAL tree, BY READING AND COMPILING — this is where plan reviews earn their keep:',
            '    * every `Modify: path:lines` range: open the file and check the range holds the code the task edits;',
            '    * every fenced code block: parse/compile it where the language allows (`python -m py_compile`,',
            '      `node --check`, `tofu validate` … on a copy in a temp file); a block shown in context may need a wrapper — say which;',
            '    * every test the plan gives: do the fixtures, helpers and imports it uses exist (grep them)? would its',
            '      Step 2 really fail red for the stated reason, and its Step 4 really go green?',
            '    * every Consumes/Produces signature: does the name defined in one task match its use in another?',
            '    * the file-overlap table: does it match every task\'s Files list? are the chains short?',
            '  DO NOT run the test suite, a task\'s tests, or the check command, and do NOT create a worktree or',
            '  splice a task in. Every task is implemented a phase later by a fresh agent that runs its tests red',
            '  and green for real, and a reviewer then re-runs the check on the whole; a test run here is paid',
            '  twice. (Measured: a plan review that spliced tasks into a worktree took 22 minutes and 77 tool calls;',
            '  its findings were ones the implementers would have hit in their own red-green cycle.)',
            '- Task decomposition: clear boundaries; steps actionable; a test cycle per task.',
            '- Sequencing: tasks in an order where each one\'s Consumes already exists.',
            'Calibration: flag only what would cause an implementer to build the wrong thing or get stuck.',
          ].join('\n')),
        '',
        DOCTRINE_REVIEW_CALIBRATION,
        'REVIEW RULES:',
        '- Every finding carries EVIDENCE: the command you ran and what it printed, the file:line you read, the',
        '  two sentences that contradict each other. Under uncertainty, raise it — you will verify it yourself',
        '  in Part 2 before it changes anything; a false negative costs a build.',
        '- status "approved" ONLY if you read the whole document and found nothing meeting that bar; then Part 2',
        '  and Part 3 are empty, and commit_sha and document_diff_stat are empty.',
        '- A decision the document took that the OWNER should make (money, risk, data, ownership, a reversal',
        '  of something that exists, a choice careful colleagues would make differently) is not a finding —',
        '  put it in `questions_for_owner` with options, consequences and your recommendation. ' +
        (PAUSE_FOR_OWNER
          ? 'The run pauses and asks. Do not raise a question the document already lists as one.'
          : 'The owner will NOT be asked in this run: write your recommended option into the document as the\n' +
            '  decision, marked "(recommended option; owner not asked)". Do not raise a question the document already lists.'),
        '',
        'PART 2 — FOLD IN. ' + DOCTRINE_RECEIVING,
        'FOLD-IN RULES:',
        '- Take your findings one at a time. VERIFY each against the document and the tree again before you act:',
        '  a finding that does not survive its own verification is `withdrawn` with the evidence in `changed`,',
        '  and the text is left as it was. Fold in the rest and say in `changed` what changed.',
        '- "Folded" means YOU edited ' + docPath + ' with your file-editing tools so that it now says the fix. A',
        '  finding marked folded whose text is unchanged in the file is a false report, not a fold-in.',
        '- The owner\'s recorded decisions (' + (kind === 'spec' ? 'the "Decisions taken without the owner" and "Decisions taken by the owner" sections' : 'the spec\'s decisions, which the plan must not silently reverse') + ')',
        '  outrank you. A finding that would reverse one is `withdrawn` on that ground, and says so.',
        '- Keep the document whole and consistent after every fold-in: file map, overlap table, self-review,',
        '  line ranges (re-measure them), test names. No placeholders may appear as a result of a fold-in.',
        '- Fix only what a finding names. A fold-in is not a rewrite: do not restructure, re-scope or polish',
        '  sections no finding touches.',
        '- Append a "## Fold-in record (review round ' + r + ')" section: a table of every finding id, severity,',
        '  disposition (folded / withdrawn) and what changed or why not.',
        '- ' + COMMIT_RULES + ' Report the commit in commit_sha.',
        '',
        'PART 3 — PROVE IT. Run `git show --stat <commit_sha> -- ' + docPath + '` and paste its output in',
        '`document_diff_stat`; it must list the document. The engine checks this: a review with findings and no',
        'new commit touching the document gets an editor sent after it, and if that fails too the run stops',
        'before anything is built.',
        (r > 1 ? '\nThis is review round ' + r + '; the fold-in of round ' + (r - 1) + ' is already in the file.' : ''),
      ].join('\n'),
      { label: kind + '-review:r' + r, phase: docPhase(kind), model: DOC_JUDGE, effort: EFFORT, schema: DOC_REVIEW_SCHEMA }
    )
    if (!review) { out.push({ round: r, review: null, fold: null, lost: 'reviewer' }); break }
    const findings = Array.isArray(review.findings) ? review.findings : []
    const folded = findings.filter((f) => f.disposition === 'folded')
    const withdrawn = findings.filter((f) => f.disposition !== 'folded')
    let commitSha = review.commit_sha || ''
    let edit = null
    const unproven = docEditUnproven(findings.length, commitSha, review.document_diff_stat, docPath, priorSha)
    if (unproven) {
      log('WARNING: the ' + kind + ' reviewer of round ' + r + ' ' + unproven + ' — sending an editor to write its ' + findings.length + ' finding(s) into ' + docPath)
      edit = await callAgent(
        [
          'You are the EDITOR of ' + docPath + '. Its adversarial reviewer (review round ' + r + ') reported the findings',
          'below with their dispositions, but it ' + unproven + '. The review is not done until the document says it.',
          '',
          'THE FINDINGS (already verified by the reviewer; do not re-litigate a disposition):',
          JSON.stringify(findings, null, 2),
          '',
          'DO THIS:',
          '- Open ' + docPath + ' as it stands now. For every `folded` finding, EDIT THE FILE so it says what the',
          '  finding\'s `fix` and `changed` say. Where the edit is already in the file, leave it.',
          '- Keep the document whole and consistent: file map, overlap table, self-review, line ranges (re-measure',
          '  them), test names. Change nothing no finding names.',
          '- Make sure a "## Fold-in record (review round ' + r + ')" section lists every finding id, severity,',
          '  disposition (folded / withdrawn) and what changed or why it was withdrawn.',
          '- ' + COMMIT_RULES,
          '- Then run `git show --stat <your commit> -- ' + docPath + '` and paste its output in `document_diff_stat`;',
          '  it must list the document.',
        ].join('\n'),
        { label: kind + '-edit:r' + r, phase: docPhase(kind), model: DOC_JUDGE, effort: EFFORT, schema: EDIT_SCHEMA }
      )
      const still = edit ? docEditUnproven(findings.length, edit.commit_sha, edit.document_diff_stat, docPath, priorSha) : 'returned nothing after its fallback'
      if (still) {
        out.push({ round: r, review, fold: null, edit, lost: 'editor', why: 'the reviewer ' + unproven + ', and the editor sent after it ' + still })
        break
      }
      commitSha = edit.commit_sha
    }
    if (commitSha) priorSha = commitSha
    // The same agent's dispositions, in the shape the earlier two-lane design reported.
    const fold = findings.length
      ? { folded: folded.map((f) => f.id), refuted: withdrawn.map((f) => ({ id: f.id, evidence: f.changed || 'withdrawn without a reason' })),
        commit_sha: commitSha, summary: review.summary }
      : null
    log(kind + ' review round ' + r + ': ' + review.status + ', ' + findings.length + ' finding(s)' +
      (findings.length ? ' — ' + folded.length + ' folded, ' + withdrawn.length + ' withdrawn @ ' + String(commitSha).slice(0, 8) + (edit ? ' (by the editor)' : '') : ''))
    out.push({ round: r, review, fold, edit })
    // A fold-in is a decision too: the reviewer changed the document on its own finding, or
    // withdrew it. Both go on the record, so the owner can overturn either.
    for (const f of folded) {
      documents.decisions.push({ stage: kind + '-fold', question: 'Review finding ' + f.id + (f.claim ? ': ' + f.claim : ''),
        decision: 'folded in' + (f.changed ? ': ' + f.changed : f.fix ? ': ' + f.fix : ''), why: f.evidence ? 'reviewer\'s evidence: ' + f.evidence : 'the finding held' })
    }
    for (const f of withdrawn) {
      documents.decisions.push({ stage: kind + '-fold', question: 'Review finding ' + f.id + (f.claim ? ': ' + f.claim : ''),
        decision: 'withdrawn; document left as it was', why: f.changed || 'no reason given' })
    }
    if (review.status === 'approved' || findings.length === 0) break
  }
  return out
}

// The owner's decisions a writer starts with, in the shape the writer must record. Answers
// come from the resume (the questions Recon raised before the spec existed); with
// pauseForOwner:false the recommended options stand and the writer is told so. Empty when
// there is nothing to record.
function ownerDecisionsBlock(stage, questions) {
  const byId = Object.fromEntries((questions || []).map((q) => [q.id, q]))
  const given = answersFor(stage)
  const lines = []
  if (given.length) {
    lines.push(
      'THE OWNER HAS ALREADY ANSWERED THESE QUESTIONS (binding; the owner outranks every reviewer and every',
      'provisional decision). Write each into the document as the decision, attributed to the owner, in a table',
      'titled "Decisions taken by the owner" (question, decision, date ' + TODAY + '), and apply its consequence',
      'throughout. Never re-raise one of them:',
      JSON.stringify(given.map((a) => ({ id: a.id, question: (byId[a.id] || {}).question || '', answer: a.answer,
        options: (byId[a.id] || {}).options || [] })), null, 2),
    )
  }
  if (!PAUSE_FOR_OWNER) {
    const answered = new Set(given.map((a) => a.id))
    const standing = (questions || []).filter((q) => !answered.has(q.id))
    if (standing.length) {
      lines.push(
        'THESE QUESTIONS WERE RAISED BEFORE YOU AND THE OWNER WAS NOT ASKED (pauseForOwner:false); the recommended',
        'option stands. Write each into the document as the decision, marked "(recommended option; owner not',
        'asked)", and do not raise it again:',
        JSON.stringify(standing.map((q) => ({ id: q.id, question: q.question, recommended: q.recommended, why: q.why })), null, 2),
      )
    }
  }
  return lines.join('\n')
}

// Recon's map of where the idea lands, as a list the writer reads before it explores.
function touchpointsBlock(points) {
  const list = (Array.isArray(points) ? points : []).filter((t) => t && t.path)
  if (!list.length) return ''
  return [
    'WHERE THE TASK LANDS (measured by Recon on the current tree). Start here: read these, cite what you read,',
    'and explore beyond them only where they run out. A file listed here that the spec does not mention needs a',
    'reason in the spec.',
    ...list.map((t) => '- ' + t.path + (t.lines ? ':' + t.lines : '') + ' — ' + (t.why || '')),
  ].join('\n')
}

// ----- Spec ---------------------------------------------------------------
if (FROM === 'idea') {
  // The questions Recon raised are the owner's before a word of the spec is written: the
  // writer then designs with the answers in hand instead of around a provisional decision
  // the reviewer has to fold around and an author has to rewrite after the pause.
  const ideaQuestions = namespaced('idea', recon.owner_questions || [])
  const pauseIdea = ownerGate('idea', ideaQuestions, null)
  if (pauseIdea) return pauseIdea
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
      touchpointsBlock(recon.touchpoints),
      '',
      ownerDecisionsBlock('idea', ideaQuestions),
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
      '  A question the owner has already answered above is settled: never raise it again.',
      OWNER_NOT_ASKED_NOTE,
      '- ' + COMMIT_RULES,
    ].join('\n'),
    { label: 'spec', phase: 'Spec', model: DOC_WRITER, effort: EFFORT, schema: SPEC_SCHEMA }
  )
  if (!spec) return { ok: false, stage: 'spec', error: 'the spec writer returned nothing', recon }
  SPEC_PATH = spec.path
  documents.spec = spec
  documents.decisions.push(...(spec.decisions || []).map((d) => ({ stage: 'spec', ...d })))
  log('spec: ' + spec.path + ' (' + spec.classification + ', ' + (spec.decisions || []).length + ' decision(s) taken without the owner)')
  documents.spec_reviews = await reviewAndFold('spec', SPEC_PATH, 'THE IDEA IT CAME FROM:\n' + TASK, spec.commit_sha)
  const specLost = docLaneLost('spec', documents.spec_reviews)
  if (specLost) return specLost
  const specQuestions = namespaced('spec', [
    ...(spec.open_questions || []),
    ...documents.spec_reviews.flatMap((r) => (r.review && r.review.questions_for_owner) || []),
  ])
  const pause = ownerGate('spec', specQuestions, SPEC_PATH)
  if (pause) return pause
  const applied = await applyAnswers('spec', SPEC_PATH, specQuestions)
  if (applied === false) return answersLost('spec', SPEC_PATH)
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
      (answersFor('idea').length || answersFor('spec').length
        ? '\nTHE OWNER\'S ANSWERS to the questions raised before and by the spec (binding; already written into the spec):\n' +
          JSON.stringify([...answersFor('idea'), ...answersFor('spec')], null, 2)
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
      '- A different model then reads the whole diff, re-runs the repo\'s check and attacks the work against',
      '  this plan, task by task. Write the plan so that judge has something exact to hold the work to.',
      '',
      'OUTPUT:',
      '- Write to `' + PLANS_DIR + '/' + TODAY + '-<slug>.md`' + (SPEC_PATH ? ' (same slug as the spec).' : '.'),
      '- ' + COMMIT_RULES,
      '- Report every task with its files and its line range in the file AFTER your final edit (grep -n).',
      '- Report in `decisions` every call the plan makes that the spec left open or that narrows it — a',
      '  declared narrowing, a migration number, an ordering, a file boundary — and write the same list into',
      '  the plan under a "## Decisions taken by the plan" heading. A narrowing hidden in a task body is the',
      '  kind of decision an owner discovers only after the build.',
      '- QUESTIONS FOR THE OWNER: a sequencing or scoping choice that affects money, risk, data, ownership,',
      '  reverses something that exists, or is one careful colleagues would make differently (a destructive',
      '  migration step, an ordering that deletes before it copies) is NOT yours to take silently: put it in',
      '  `open_questions` with two to four options, the consequence of each, and your recommendation; write the',
      '  recommended option into the plan as the provisional decision, marked "pending owner". The run pauses',
      '  and asks. Everything below that bar, decide and record.',
      OWNER_NOT_ASKED_NOTE,
    ].join('\n'),
    { label: 'plan-doc', phase: 'Plan', model: DOC_WRITER, effort: EFFORT, schema: PLANDOC_SCHEMA }
  )
  if (!planDoc) return { ok: false, stage: 'plan', error: 'the plan writer returned nothing', recon, documents }
  PLAN_PATH = planDoc.path
  documents.plan = planDoc
  documents.decisions.push(...(planDoc.decisions || []).map((d) => ({ stage: 'plan', ...d })))
  log('plan: ' + planDoc.path + ' (' + planDoc.tasks.length + ' task(s), ' + (planDoc.decisions || []).length + ' decision(s))')
  documents.plan_reviews = await reviewAndFold('plan', PLAN_PATH, (SPEC_PATH ? 'THE SPEC IT IMPLEMENTS: ' + SPEC_PATH : 'THE REQUIREMENTS:\n' + TASK), planDoc.commit_sha)
  const planLost = docLaneLost('plan', documents.plan_reviews)
  if (planLost) return planLost
  const planQuestions = namespaced('plan', [
    ...(planDoc.open_questions || []),
    ...documents.plan_reviews.flatMap((r) => (r.review && r.review.questions_for_owner) || []),
  ])
  const pausePlan = ownerGate('plan', planQuestions, PLAN_PATH)
  if (pausePlan) return pausePlan
  const appliedPlan = await applyAnswers('plan', PLAN_PATH, planQuestions)
  if (appliedPlan === false) return answersLost('plan', PLAN_PATH)
  if (appliedPlan) log('plan: owner answers recorded (' + (appliedPlan.commit_sha || 'no commit') + ')')
  planReindexed = documents.plan_reviews.some((r) => r.fold && r.fold.commit_sha) || Boolean(appliedPlan && appliedPlan.commit_sha)
}

// There is no consolidated decision recorder (removed 2026-09-12: a 6-minute Sonnet lane
// that re-wrote 45 decisions already present in the documents' own tables — the spec
// writer's, the plan writer's, each fold-in record and the owner's answers). Every
// decision is still in `documents.decisions`, in order, and in the documents themselves.
// Line ranges move under a fold-in and an answers commit, and the slicer hands them to
// implementers as pointers — so the plan is measured once, AFTER the last agent that
// wrote into it (a 25-second Sonnet call). The plan writer's decisions stay on the record.
if (planReindexed && planDoc) {
  const remeasured = await callAgent(
    [
      'Read ' + PLAN_PATH + ' as it stands NOW and report every "### Task N" section in order with its files',
      'and its line range (grep -n "^### Task" and "^## Global Constraints"; the range ends where the next',
      'section starts). Report the commit_sha as `git rev-parse HEAD`. Do not edit anything.',
    ].join('\n'),
    { label: 'plan-index', phase: 'Plan review', model: CODER, effort: 'low', schema: PLANDOC_SCHEMA }
  )
  if (remeasured) { planDoc = { ...remeasured, decisions: planDoc.decisions || [], open_questions: planDoc.open_questions || [] }; documents.plan = planDoc }
}

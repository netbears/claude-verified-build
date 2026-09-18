// ---------------------------------------------------------------------------
// Phase 2 — Implement. ONE AGENT PER SLICE, always. A group means "these run in
// order", not "these share a context": file-disjointness governs concurrency and
// nothing else. Merging N slices into one agent is how a run ends up with a
// single 600k-token context and no verification until the very end.
// ---------------------------------------------------------------------------
phase('Implement')

// The early return every phase below uses when the token budget is nearly gone.
function outOfBudget(stage, extra) {
  log('stopping before ' + stage + ': ' + Math.round(budget.remaining() / 1000) + 'k tokens left in the turn\'s budget')
  return { ok: false, stage: stage, error: 'token budget nearly exhausted before ' + stage + ' (' + Math.round(budget.remaining() / 1000) + 'k left); nothing past this point ran',
    base_sha: BASE, diff_command: DIFF_CMD, recon: recon, documents: documentsReport(),
    plan: planReport(),
    lane_errors: laneErrors, ...(extra || {}) }
}
if (!budgetLeft(60000)) return outOfBudget('implement')

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
    '- Commit with a clear message, and commit BY PATHSPEC: `git add <file>` for each file you edited, then',
    '  `git commit -m "<message>" -- <file> <file>…` naming the same files. The index is shared with other',
    '  implementers working in this tree at the same time; a plain `git commit` would carry whatever they have',
    '  staged into your commit, and `git commit -- <files>` commits only the paths you name. Never `git add -A`,',
    '  `git add .` or `git commit -a`: a sweep commits their half-written work under your name. If git fails on',
    '  `index.lock`, wait a moment and retry; do not delete the lock.',
    '- Do NOT push. Do NOT merge or rebase branches. Do NOT amend commits you did not make. Do NOT stash, reset or',
    '  check out anything: the tree is shared.',
    '- If the check fails on a file outside your slice that you did not touch, another implementer may be mid-edit:',
    '  re-run once after a short wait, and if it still fails say exactly that in notes rather than "fixing" their file.',
    '- If the slice defeats you, commit what is genuinely correct and report it as partial or failed.',
    '',
    'Another model that did not write this code will review the real diff and re-run whatever this repo can',
    'run. Claiming a check passed when you did not run it will be caught, so report exactly what you ran and',
    'exactly what happened.',
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

const built = (await runGroups(groups, WAVE, implementGroup, 'implement wave')).filter(Boolean).flat()
// callAgent never throws, so a group can only go missing if the runtime dropped it;
// name the slices rather than let the count quietly shrink.
const neverRan = plan.slices.filter((s) => !built.some((b) => b.slice.id === s.id)).map((s) => s.id)
const notImplemented = built.filter((b) => !b.impl).map((b) => b.slice.id)
if (neverRan.length) log('WARNING: ' + neverRan.length + ' slice(s) never ran (the runtime dropped their group): ' + neverRan.join(', '))
if (notImplemented.length) log('WARNING: ' + notImplemented.length + ' slice(s) had no implementer result after the fallback: ' + notImplemented.join(', '))
const violations = footprintViolations(built, groups)
if (violations.length) log('WARNING: ' + violations.length + ' undeclared file(s) touched inside another group\'s footprint: ' +
  violations.map((v) => v.slice + ' -> ' + v.file + ' (declared by ' + v.collides_with.join(', ') + ')').join('; '))

log('implemented ' + built.length + '/' + plan.slices.length + ' slice(s)')
// The implementers' own reports, as the adversary sees them: claims, not evidence.
const implReports = built.map((b) => ({ slice: b.slice.id, impl: b.impl }))

function sliceBlock(s) {
  return [
    '--- SLICE ' + s.id + ': ' + s.title,
    'what:      ' + s.prompt,
    'files:     ' + (s.files || []).join(', '),
    'done when: ' + s.done_when,
  ].join('\n')
}

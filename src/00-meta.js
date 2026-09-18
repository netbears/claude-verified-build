export const meta = {
  name: 'build-verify-patch',
  description: 'From an idea: Sonnet writes the spec and Opus reviews and folds it in; the same for the plan; then Sonnet implements in waves of 15, Opus adversarially reviews the combined diff and re-runs the repo\'s check, and one patch round closes critical/major findings',
  whenToUse: 'A multi-file feature, refactor, migration or non-trivial bugfix where you want the code written cheaply, verified by a model that did not write it, and attacked before you trust it. Works on any git repo in any language. Overkill for a one-line fix.',
  phases: [
    { title: 'Probe', detail: 'one trivial call per primary model: is each of them enabled for this account?' },
    { title: 'Recon', detail: 'sonnet reads the repo: git state, ecosystem, how it verifies itself, where the idea lands, what the owner must decide first', model: 'sonnet' },
    { title: 'Spec', detail: 'sonnet (docWriter overrides) turns the idea into a spec (brainstorming doctrine) from recon\'s map and the owner\'s answers, commits it', model: 'sonnet' },
    { title: 'Spec review', detail: 'opus (docJudge overrides) adversarially reviews the spec, then folds its own findings in', model: 'opus' },
    { title: 'Plan', detail: 'sonnet (docWriter overrides) writes the implementation plan from the spec (writing-plans doctrine), commits it', model: 'sonnet' },
    { title: 'Plan review', detail: 'opus (docJudge overrides) adversarially reviews the plan against the tree (reading and compiling, never running the tests), then folds its own findings in', model: 'opus' },
    { title: 'Slice', detail: 'opus maps the plan\'s tasks onto file-disjoint slices', model: 'opus' },
    { title: 'Implement', detail: 'sonnet writes and commits each slice', model: 'sonnet' },
    { title: 'Review', detail: 'opus adversarially reviews the combined diff and re-runs the repo\'s check', model: 'opus' },
    { title: 'Patch', detail: 'sonnet fixes each critical/major finding; opus re-reviews the whole diff (1 round by default)', model: 'sonnet' },
  ],
}

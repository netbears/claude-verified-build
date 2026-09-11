# verified-build

A Claude Code skill and the saved Workflow it drives. From an idea, a spec or a plan:
**Opus writes the spec and adversarially reviews it, writes the plan and reviews it, both
committed on the branch as it goes; Sonnet implements, Opus verifies every commit against
the real diff and re-runs the repo's own checks, Opus adversarially reviews the combined
diff, Sonnet patches the critical and major findings, Opus re-attacks.** Nothing is called
done because the model that wrote it said so. Works on any git repo in any language: the
first agent (Recon) discovers from the repo itself what "the checks pass" means, so the
engine is never hand-tuned per project.

There is no human in the loop while it runs. A writer with a question decides the way a
careful colleague would and records it in a "Decisions taken without the owner" table;
those decisions come back first in the result, for the owner to overturn.

The stages carry the doctrine of the [superpowers](https://github.com/obra/superpowers)
skills (MIT, Jesse Vincent) — brainstorming, writing-plans, the spec and plan reviewer
templates, receiving-code-review, test-driven-development, verification-before-completion,
systematic-debugging, the code-reviewer calibration — copied into the engine so an install
without the plugin behaves identically. Only the interactive parts were adapted.

## Layout

```
skills/verified-build/SKILL.md     the entry point: pre-flight, the call, how to read the result
workflows/build-verify-patch.js    the engine: a deterministic Workflow script (plain JS)
install.sh                         copies the pair into one or more Claude config dirs (local or user@host:dir)
check.sh                           node --check for the engine (see the comment for why it wraps the body)
```

The two files are a pair and travel together. The names differ on purpose: an
identically-named workflow would shadow the skill in the registry and skip its pre-flight.

## Install

```
./install.sh                                   # $CLAUDE_CONFIG_DIR or ~/.claude
./install.sh ~/.claude-work ~/.claude-personal  # several profiles
./install.sh cloud:~/.claude-stonks             # a remote box, via scp
```

Then `/reload-skills` in a running session, or restart the resident session on a server.
Every copy should be byte-identical; `install.sh` prints the checksums so you can see it.

## Use

`/verified-build <an idea, or a path to a spec or a plan>` — `from: idea | spec | plan`
picks where the run starts. Read `SKILL.md` for the pre-flight (clean tree, a branch that
is not the trunk, worktree rules), the arguments, and how to report the result honestly:
the decisions taken without the owner first, then the adversary's verdict, then the
leftovers the orchestrator must close by hand at every severity. The skill is the opt-in
that permits the Workflow tool.

## What it costs and where the time goes

Measured on six runs (2026-09-09 to 09-11, one Python repo, plans of 5 to 12 tasks):
25 hours of wall clock, about 2.3 billion cached-read tokens, roughly 30 to 60 agents a
run. The patch rounds were 46% of the time and 51% of the tokens and the source of most
patch-introduced defects, which is why the defaults are now one patch round and
critical/major findings only; the rest of the findings come back to the orchestrator.
The full record is in `SKILL.md` under "Tuned from six runs".

## Changing it

Edit, run `./check.sh`, reinstall everywhere with `install.sh`, commit. Keep the engine at
two-space indent. `SKILL.md`'s argument table and its "Reading the result" section must
match the engine's inputs and return value; a knob that exists in only one of them is a
knob nobody uses.

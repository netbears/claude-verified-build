# verified-build

A Claude Code skill and the saved Workflow it drives. **Sonnet implements, Opus verifies
every commit against the real diff and re-runs the repo's own checks, Opus adversarially
reviews the combined diff, Sonnet patches the critical and major findings, Opus re-attacks.**
Nothing is called done because the model that wrote it said so. Works on any git repo in
any language: the first agent (Recon) discovers from the repo itself what "the checks
pass" means, so the engine is never hand-tuned per project.

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

`/verified-build <task or path to a plan>` — read `SKILL.md` for the pre-flight (clean
tree, a branch that is not the trunk, worktree rules), the arguments, and how to report
the result honestly. The skill is the opt-in that permits the Workflow tool.

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

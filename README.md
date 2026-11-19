# omp-pr-watch

An [omp](https://github.com/can1357/oh-my-pi) plugin that tracks the pull requests a session
opens and wakes that session when something needs action: CI failed, review feedback, merge
conflict, all checks green, or the PR merged/closed.

## Install

```sh
git clone https://github.com/sglyon/omp-pr-watch.git
omp plugin link ./omp-pr-watch
```

Requires `gh` on `PATH`, authenticated. Push delivery uses `gh event listen` (gh ≥ 2.105.0, a
preview GitHub enables per account); without it the plugin polls every 2 minutes.

## Use

PRs are tracked automatically when the session (or one of its `task` subagents) runs
`gh pr create` or the `github` tool's `pr_create`. Manually:

| Command | Effect |
|---|---|
| `/pr-watch` | List tracked PRs |
| `/pr-watch <url> [--automerge]` | Track a PR; `--automerge` lets the agent merge on green |
| `/pr-watch rm <url>` | Stop tracking |

On green checks the agent merges only when the PR is approved (`reviewDecision=APPROVED`) or
was added with `--automerge`; otherwise it reports ready-to-merge. After 3 wakes on one PR
without a user prompt in between, it stops and asks you to take over.

Design: [`docs/superpowers/specs/2026-11-19-pr-watch-design.md`](docs/superpowers/specs/2026-11-19-pr-watch-design.md).

## Develop

```sh
bun test
```

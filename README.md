# omp-pr-watch

An [omp](https://github.com/can1357/oh-my-pi) plugin that tracks the pull requests a session
opens and wakes that session when something needs action: CI failed, review feedback, merge
conflict, all checks green, or the PR merged/closed.

Push delivery uses `gh event listen` (gh ≥ 2.105.0); older gh falls back to polling.

Status: design only. See
[`docs/superpowers/specs/2026-11-19-pr-watch-design.md`](docs/superpowers/specs/2026-11-19-pr-watch-design.md).

## Install

```sh
git clone https://github.com/sglyon/omp-pr-watch.git
omp plugin link ./omp-pr-watch
```

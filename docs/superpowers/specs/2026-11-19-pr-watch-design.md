# pr-watch — design

Date: 2026-11-19. Status: approved; implemented in v0.1.0.

## Goal

An omp extension that tracks PRs a session opens, watches their status on GitHub, and wakes
the owning session with a concrete instruction to continue when something actionable changes.

## Non-goals

- Watching while omp is closed. Reopening the session catches up immediately.
- Coordinating between sessions. Two sessions tracking one PR both wake.
- Webhooks, external services, dashboards beyond `/pr-watch`.
- GitHub Enterprise push delivery (`gh event listen` is github.com-only; those PRs poll).

## Files

An omp plugin in the public repo `sglyon/omp-pr-watch`, laid out like `sglyon/omp-fusion`:
`package.json` carries the `omp` manifest listing `extensions/pr-watch/index.ts`. Distributed via
the dots manifest (`.chezmoidata/omp.yaml` `omp.plugins`, pinned ref, checkout at
`~/.local/share/dots-deps/omp-pr-watch`, `omp plugin link`); kenya links its `~/src` dev checkout.

| File | Responsibility |
|---|---|
| `extensions/pr-watch/index.ts` | Wiring: hooks, `/pr-watch` command, state persistence, wake delivery, loop guard. |
| `extensions/pr-watch/detect.ts` | Pure: extract created-PR URLs from a `tool_result` event. |
| `extensions/pr-watch/snapshot.ts` | Pure: `gh` JSON → `Snapshot`; `(prev Fingerprint, Snapshot, now)` → `{ events, next Fingerprint }`; wake text. |
| `extensions/pr-watch/listener.ts` | One `gh event listen --follow` child per PR: spawn, line reading, restart with backoff, kill. |
| `tests/snapshot.test.ts`, `tests/detect.test.ts` | `bun test` on fixture JSON. |

## Tracking

A PR is tracked when any of these happen in the main session:

1. `tool_result` for `bash` whose `input.command` contains `gh pr create` and whose output
   contains `https://github.com/<owner>/<repo>/pull/<n>`.
2. `tool_result` for the `github` tool with `input.op === "pr_create"`. Verified on omp 19.0.0:
   an `xd://github` write surfaces as `toolName === "github"` with the op object as `input`.
   `write` to `xd://github` and `eval` code containing `gh pr create` are also matched.
3. `/pr-watch <url> [--automerge]`.
4. A subagent session hits 1 or 2. Verified on omp 19.0.0: `task` subagents run in-process and
   share the module instance (the factory re-runs per session), so the subagent instance pushes
   the URL onto a module-level queue that the main instance drains immediately and on every tick.

Only `ctx.agent.kind === "main"` runs listeners, timers, and wakes.

Commands:

- `/pr-watch` — list tracked PRs with last known status.
- `/pr-watch <url> [--automerge]` — track (or re-flag) a PR.
- `/pr-watch rm <url>` — stop tracking.

`--automerge` is only settable by the user via the command; auto-detected PRs default to
`automerge: false`.

## State

Persisted with `pi.appendEntry("sglyon.pr-watch.state", { prs: TrackedPr[] })`; each change
appends a full snapshot, the last entry on the branch wins. Rebuilt from
`ctx.sessionManager.getBranch()` on `session_start`, `session_branch`, `session_tree`;
`session_switch` tears down listeners and rebuilds. "Forget" = append a snapshot without the PR.

```ts
type TrackedPr = {
	url: string;               // canonical https://github.com/o/r/pull/n
	automerge: boolean;
	fp: Fingerprint | null;    // null until first snapshot
	wakes: number;             // action wakes since the last user prompt
	halted: boolean;           // loop guard tripped; no wakes until next user prompt
};

type Fingerprint = {
	state: "OPEN" | "MERGED" | "CLOSED";
	headSha: string;
	mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
	feedbackSeenAt: string;     // ISO; newest non-self review/comment already reported
	reportedFailSha?: string;   // head SHA we already woke for ci_failed
	reportedGreenSha?: string;  // head SHA we already woke for ci_green
	noChecksSince?: { sha: string; at: number }; // see "No-CI repos"
};
```

## Delivery: events + reconciliation

1. **Push.** Per tracked PR, `listener.ts` spawns
   `gh event listen --resource <url> --follow --event <review.submitted, state.changed, head.changed, merge_conflict, check_suite.status.changed>`
   (full `com.github.pull_request.*.v1` names). Any stdout line, and any stderr line (the
   stream-attached status message), schedules a snapshot for that PR, debounced 15s so a burst
   of check-suite completions yields one snapshot. Event payloads are never interpreted.
2. **Reconcile.** `ctx.setInterval` every 10 min snapshots every tracked PR. This catches plain
   issue/review-thread comments (no event type exists) and anything lost while disconnected.
3. **Catch-up.** Snapshot every PR on `session_start`/restore and on each stream attach.
4. **Restart.** Listener exit (including 24h subscription expiry) → respawn with backoff
   5s, 30s, 2m, 5m (cap). Three exits within 10 min with no stdout event → that PR drops to
   poll mode.
5. **Fallback.** If `gh event --help` fails at `session_start`, or a listener reports the account
   lacks event subscriptions (`HTTP 403: Event subscriptions are not enabled for this account`;
   the feature is a gated preview), all PRs use poll mode for the rest of the session: snapshot
   every 120s, no listeners.
6. **Hygiene.** Children tracked in a `Map<url, Subprocess>`, killed on `session_shutdown` and on
   untrack. All stream/exit callbacks wrapped in try/catch; a per-PR in-flight flag prevents
   overlapping snapshots.

## Snapshot

Two calls per PR:

1. `gh pr view <url> --json state,mergeable,reviewDecision,headRefOid,statusCheckRollup,reviews,comments`
2. `gh api repos/<o>/<r>/pulls/<n>/comments --paginate` (review-thread comments; not in `pr view`).

Self login from `gh api user --jq .login`, fetched once per session. Failures are logged via
`ctx.ui.notify` at most once per PR per hour and skipped.

**Checks rollup** from `statusCheckRollup` (CheckRun `status`/`conclusion`, StatusContext `state`):

- `pending`: any check not completed.
- `failed`: all completed, any conclusion in `FAILURE, TIMED_OUT, CANCELLED, ACTION_REQUIRED,
  STARTUP_FAILURE` or state `FAILURE, ERROR`.
- `passed`: all completed, none failed.
- `none`: empty rollup.

**No-CI repos.** An empty rollup right after a push is indistinguishable from a repo with no CI.
`none` counts as `passed` only when the same head SHA showed `none` in a snapshot ≥5 min earlier
(`noChecksSince`).

## Events

Computed by `snapshot.ts` from `(fp, snapshot, now)`; only transitions fire.

| Event | Fires when | Then |
|---|---|---|
| `closed` | `state !== "OPEN"` | Wake with report, untrack. Suppresses all other events. |
| `ci_failed` | rollup `failed` and `reportedFailSha !== headSha` | Set `reportedFailSha`. |
| `conflict` | `mergeable === "CONFLICTING"` and previous was not | — |
| `review_feedback` | any review/comment by someone other than self, newer than `feedbackSeenAt` | Advance `feedbackSeenAt`. Bots count. |
| `ci_green` | rollup `passed` (or settled `none`), not conflicting, `reportedGreenSha !== headSha` | Set `reportedGreenSha`. |

First snapshot of a newly tracked PR seeds `feedbackSeenAt` to the newest existing item (no
wake for history), but CI/conflict state fires normally. Multiple events in one snapshot
coalesce into one wake.

## Wake

```ts
pi.sendMessage(
	{ customType: "sglyon.pr-watch.wake", content: wakeText(pr, events, snapshot), display: true },
	{ triggerTurn: true, deliverAs: ctx.isIdle() ? undefined : "followUp" },
);
```

`followUp` never interrupts a running turn. Wake text names the PR and each event with detail
(failed check names + links, review/comment author and excerpt ≤500 chars, conflict) and the
instruction:

- `ci_failed` → investigate the failing checks (`gh run view --log-failed`), fix, push.
- `review_feedback` → address the feedback, push, reply on the PR.
- `conflict` → rebase on / merge the base branch, resolve, push.
- `ci_green` → if `reviewDecision === "APPROVED"` or `automerge`, merge with `gh pr merge`
  using the repo's allowed method and `--delete-branch`; otherwise report ready-to-merge and stop.
- `closed` → report outcome; no action.

The check is restated in the text, but the decision to authorize merge comes from the snapshot,
so the agent is told explicitly whether merging is allowed.

## Loop guard

`wakes` increments per action wake and resets to 0 on any user-authored prompt:
`before_agent_start` with `reason: "prompt"` (fires for user prompts in every mode) and `input`
with `source` `interactive`/`rpc`. Verified: wake turns from `triggerTurn`/`followUp` fire
neither. On the wake that would be the 4th, the extension instead sends a halt
wake: "stop acting on <PR>; summarize the failure loop and pin a `T` sticky note for the user",
and sets `halted`. Halted PRs keep updating their fingerprint but do not wake until reset.
`closed` always wakes.

## Testing

1. `bun test` over `snapshot.ts` and `detect.ts` with fixture `gh` JSON: each event's fire and
   no-fire cases, coalescing, first-snapshot seeding, self/bot filtering, no-CI settling,
   `closed` suppression, pending checks never firing `ci_failed`.
2. E2E in tmux: private scratch repo `sglyon/omp-pr-watch-e2e` with a trivial GitHub Actions
   check. omp session runs `gh pr create`; push a failing commit → session wakes on its own and
   pushes a fix → green wake reports ready-to-merge (no automerge). Repeat with
   `/pr-watch <url> --automerge` → merges. Verify the subagent path by creating a PR from a `task` subagent.

## Docs

Update JDex `14.23 omp Agent Configuration.md`; bump the pinned `ref` in `.chezmoidata/omp.yaml`
whenever a release commit lands.

## Risks

- R2: no cross-session dedupe.
- R3: `gh event listen` is new (v2.105.0, 2026-11-18) and preview-gated per account; it returned
  403 for `sglyon` on 2026-11-19, so polling is the live path until GitHub enables it. Only event
  arrival is depended on.
- R4: auto-merge is opt-in per PR; approved PRs merge without asking.

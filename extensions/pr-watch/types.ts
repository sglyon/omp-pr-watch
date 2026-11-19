// Shared contract for the pr-watch modules. Pure data; no runtime imports.

/** Canonical reference to a GitHub pull request. `url` is `https://<host>/<owner>/<repo>/pull/<number>`. */
export type PrRef = { host: string; owner: string; repo: string; number: number; url: string };

export type PrState = "OPEN" | "MERGED" | "CLOSED";
export type Mergeable = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";

/** Rolled-up status of every check on the head commit. */
export type ChecksState = "pending" | "failed" | "passed" | "none";

export type FailedCheck = { name: string; url?: string };

/** One review, issue comment, or review-thread comment authored by someone other than the session's user. */
export type Feedback = {
	id: string;
	kind: "review" | "comment" | "review_comment";
	author: string;
	isBot: boolean;
	/** ISO timestamp (review submittedAt / comment createdAt). */
	at: string;
	body: string;
	url?: string;
	/** Review state (APPROVED, CHANGES_REQUESTED, COMMENTED, ...) for kind === "review". */
	state?: string;
	/** File path for kind === "review_comment". */
	path?: string;
};

/** Normalized view of a PR at one instant, built from `gh` JSON. Self-authored feedback is already excluded. */
export type Snapshot = {
	state: PrState;
	headSha: string;
	mergeable: Mergeable;
	/** APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | "" */
	reviewDecision: string;
	checks: ChecksState;
	failedChecks: FailedCheck[];
	/** Sorted ascending by `at`. */
	feedback: Feedback[];
};

/** What has already been observed/reported for a PR; persisted so resumed sessions don't re-wake. */
export type Fingerprint = {
	state: PrState;
	headSha: string;
	mergeable: Mergeable;
	/** ISO timestamp of the newest feedback already reported ("" = none). */
	feedbackSeenAt: string;
	reportedFailSha?: string;
	reportedGreenSha?: string;
	/** First time an empty check rollup was seen on `sha`; `none` settles to passed after NO_CHECKS_SETTLE_MS. */
	noChecksSince?: { sha: string; at: number };
};

export type TrackedPr = {
	url: string;
	automerge: boolean;
	fp: Fingerprint | null;
	/** Action wakes since the user last prompted. */
	wakes: number;
	/** Loop guard tripped; no wakes (except `closed`) until the user prompts. */
	halted: boolean;
};

export type PrEvent =
	| { kind: "closed"; state: "MERGED" | "CLOSED" }
	| { kind: "ci_failed"; checks: FailedCheck[] }
	| { kind: "conflict" }
	| { kind: "review_feedback"; items: Feedback[] }
	| { kind: "ci_green"; mergeAllowed: boolean };

export type PersistedState = { version: 1; prs: TrackedPr[] };

/** Signature of `pi.exec`. */
export type Exec = (
	command: string,
	args: string[],
	options?: { timeout?: number; signal?: AbortSignal; cwd?: string },
) => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>;

export const STATE_ENTRY_TYPE = "sglyon.pr-watch.state";
export const WAKE_MESSAGE_TYPE = "sglyon.pr-watch.wake";
export const NO_CHECKS_SETTLE_MS = 5 * 60_000;
export const MAX_ACTION_WAKES = 3;
export const RECONCILE_MS = 10 * 60_000;
export const POLL_MS = 120_000;
export const EVENT_DEBOUNCE_MS = 15_000;
export const EVENT_TYPES = [
	"com.github.pull_request.review.submitted.v1",
	"com.github.pull_request.state.changed.v1",
	"com.github.pull_request.head.changed.v1",
	"com.github.pull_request.merge_conflict.v1",
	"com.github.pull_request.check_suite.status.changed.v1",
] as const;

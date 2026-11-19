import { describe, expect, test } from "bun:test";
import { diffSnapshot, haltText, toSnapshot, wakeText } from "../extensions/pr-watch/snapshot";
import { NO_CHECKS_SETTLE_MS } from "../extensions/pr-watch/types";
import type { Fingerprint, Snapshot } from "../extensions/pr-watch/types";

const URL = "https://github.com/octo-org/widgets/pull/1";

function view(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		state: "OPEN",
		mergeable: "MERGEABLE",
		reviewDecision: "",
		headRefOid: "sha1",
		statusCheckRollup: [],
		reviews: [],
		comments: [],
		...overrides,
	};
}

function checkRun(overrides: Record<string, unknown>): Record<string, unknown> {
	return {
		__typename: "CheckRun",
		status: "COMPLETED",
		conclusion: "SUCCESS",
		name: "build",
		startedAt: "2026-11-19T10:00:00Z",
		completedAt: "2026-11-19T10:01:00Z",
		detailsUrl: "https://github.com/octo-org/widgets/actions/runs/1",
		workflowName: "CI",
		...overrides,
	};
}

function statusContext(overrides: Record<string, unknown>): Record<string, unknown> {
	return {
		__typename: "StatusContext",
		context: "ci/legacy",
		state: "SUCCESS",
		targetUrl: "https://ci.example/1",
		...overrides,
	};
}

describe("toSnapshot — checks rollup", () => {
	test("empty rollup -> none", () => {
		const snap = toSnapshot(view(), [], "alice");
		expect(snap.checks).toBe("none");
		expect(snap.failedChecks).toEqual([]);
	});

	test("all completed, none failed -> passed", () => {
		const snap = toSnapshot(view({ statusCheckRollup: [checkRun({})] }), [], "alice");
		expect(snap.checks).toBe("passed");
	});

	test("incomplete CheckRun -> pending", () => {
		const rollup = [checkRun({ status: "IN_PROGRESS", conclusion: "" })];
		const snap = toSnapshot(view({ statusCheckRollup: rollup }), [], "alice");
		expect(snap.checks).toBe("pending");
	});

	test("completed failure -> failed, with name+url", () => {
		const rollup = [checkRun({ name: "lint", conclusion: "FAILURE", detailsUrl: "https://x/1" })];
		const snap = toSnapshot(view({ statusCheckRollup: rollup }), [], "alice");
		expect(snap.checks).toBe("failed");
		expect(snap.failedChecks).toEqual([{ name: "lint", url: "https://x/1" }]);
	});

	test("pending overrides failed when mixed", () => {
		const rollup = [
			checkRun({ name: "lint", status: "COMPLETED", conclusion: "FAILURE" }),
			checkRun({ name: "build", status: "IN_PROGRESS", conclusion: "" }),
		];
		const snap = toSnapshot(view({ statusCheckRollup: rollup }), [], "alice");
		expect(snap.checks).toBe("pending");
		expect(snap.failedChecks).toEqual([]);
	});

	test("StatusContext EXPECTED/PENDING -> pending", () => {
		const snap = toSnapshot(view({ statusCheckRollup: [statusContext({ state: "PENDING" })] }), [], "alice");
		expect(snap.checks).toBe("pending");
	});

	test("StatusContext FAILURE/ERROR -> failed with context+targetUrl", () => {
		const rollup = [statusContext({ context: "ci/legacy", state: "ERROR", targetUrl: "https://ci/9" })];
		const snap = toSnapshot(view({ statusCheckRollup: rollup }), [], "alice");
		expect(snap.checks).toBe("failed");
		expect(snap.failedChecks).toEqual([{ name: "ci/legacy", url: "https://ci/9" }]);
	});

	test("rerun dedupe: same CheckRun name twice, latest startedAt wins", () => {
		const rollup = [
			checkRun({ name: "build", startedAt: "2026-11-19T10:00:00Z", conclusion: "FAILURE" }),
			checkRun({ name: "build", startedAt: "2026-11-19T10:05:00Z", conclusion: "SUCCESS" }),
		];
		const snap = toSnapshot(view({ statusCheckRollup: rollup }), [], "alice");
		expect(snap.checks).toBe("passed");
		expect(snap.failedChecks).toEqual([]);
	});
});

describe("toSnapshot — feedback filtering", () => {
	test("self-filter is case-insensitive", () => {
		const v = view({
			reviews: [{ author: { login: "Alice" }, body: "lgtm", state: "APPROVED", submittedAt: "t1" }],
			comments: [{ author: { login: "ALICE" }, body: "hi", createdAt: "t2" }],
		});
		const snap = toSnapshot(v, [], "alice");
		expect(snap.feedback).toEqual([]);
	});

	test("bot detection via user.type and login suffix", () => {
		const reviewComments = [
			{ id: 1, user: { login: "ci-bot", type: "Bot" }, body: "a", created_at: "t1", html_url: "u1", path: "p1" },
			{ id: 2, user: { login: "dependabot[bot]", type: "User" }, body: "b", created_at: "t2", html_url: "u2" },
		];
		const snap = toSnapshot(view(), reviewComments, "alice");
		expect(snap.feedback.map((f) => f.isBot)).toEqual([true, true]);
	});

	test("empty-body COMMENTED review is skipped (inline-comment container)", () => {
		const v = view({
			reviews: [
				{ author: { login: "bob" }, body: "", state: "COMMENTED", submittedAt: "t1" },
				{ author: { login: "bob" }, body: "actual review", state: "CHANGES_REQUESTED", submittedAt: "t2" },
			],
		});
		const snap = toSnapshot(v, [], "alice");
		expect(snap.feedback.length).toBe(1);
		expect(snap.feedback[0]!.body).toBe("actual review");
	});

	test("feedback is sorted ascending by at, across reviews/comments/review_comments", () => {
		const v = view({
			reviews: [{ author: { login: "bob" }, body: "r", state: "APPROVED", submittedAt: "2026-11-19T12:00:00Z" }],
			comments: [{ author: { login: "carol" }, body: "c", createdAt: "2026-11-19T10:00:00Z" }],
		});
		const reviewComments = [
			{ id: 9, user: { login: "dave", type: "User" }, body: "rc", created_at: "2026-11-19T11:00:00Z", html_url: "u" },
		];
		const snap = toSnapshot(v, reviewComments, "alice");
		expect(snap.feedback.map((f) => f.author)).toEqual(["carol", "dave", "bob"]);
	});
});

describe("diffSnapshot — events", () => {
	const fp = (overrides: Partial<Fingerprint> = {}): Fingerprint => ({
		state: "OPEN",
		headSha: "sha1",
		mergeable: "MERGEABLE",
		feedbackSeenAt: "",
		...overrides,
	});

	test("ci_failed fires on failed checks, no-fire on repeat snapshot (same sha)", () => {
		const snap: Snapshot = {
			state: "OPEN",
			headSha: "sha1",
			mergeable: "MERGEABLE",
			reviewDecision: "",
			checks: "failed",
			failedChecks: [{ name: "lint" }],
			feedback: [],
		};
		const first = diffSnapshot(fp(), snap, { now: 0, automerge: false });
		expect(first.events).toEqual([{ kind: "ci_failed", checks: [{ name: "lint" }] }]);
		expect(first.next.reportedFailSha).toBe("sha1");

		const second = diffSnapshot(first.next, snap, { now: 1000, automerge: false });
		expect(second.events).toEqual([]);
	});

	test("ci_failed re-arms on a new head sha", () => {
		const base = fp({ reportedFailSha: "sha1" });
		const snap: Snapshot = {
			state: "OPEN",
			headSha: "sha2",
			mergeable: "MERGEABLE",
			reviewDecision: "",
			checks: "failed",
			failedChecks: [{ name: "lint" }],
			feedback: [],
		};
		const result = diffSnapshot(base, snap, { now: 0, automerge: false });
		expect(result.events).toEqual([{ kind: "ci_failed", checks: [{ name: "lint" }] }]);
	});

	test("pending checks never fire ci_failed", () => {
		const snap: Snapshot = {
			state: "OPEN",
			headSha: "sha1",
			mergeable: "MERGEABLE",
			reviewDecision: "",
			checks: "pending",
			failedChecks: [],
			feedback: [],
		};
		const result = diffSnapshot(fp(), snap, { now: 0, automerge: false });
		expect(result.events).toEqual([]);
	});

	test("conflict fires on transition to CONFLICTING, no-fire while it stays CONFLICTING", () => {
		const snap: Snapshot = {
			state: "OPEN",
			headSha: "sha1",
			mergeable: "CONFLICTING",
			reviewDecision: "",
			checks: "none",
			failedChecks: [],
			feedback: [],
		};
		const first = diffSnapshot(fp({ mergeable: "MERGEABLE" }), snap, { now: 0, automerge: false });
		expect(first.events).toEqual([{ kind: "conflict" }]);
		const second = diffSnapshot(first.next, snap, { now: 1000, automerge: false });
		expect(second.events).toEqual([]);
	});

	test("conflict on the very first snapshot counts", () => {
		const snap: Snapshot = {
			state: "OPEN",
			headSha: "sha1",
			mergeable: "CONFLICTING",
			reviewDecision: "",
			checks: "none",
			failedChecks: [],
			feedback: [],
		};
		const result = diffSnapshot(null, snap, { now: 0, automerge: false });
		expect(result.events.some((e) => e.kind === "conflict")).toBe(true);
	});

	test("review_feedback fires for new items only, advances feedbackSeenAt", () => {
		const prev = fp({ feedbackSeenAt: "2026-11-19T10:00:00Z" });
		const snap: Snapshot = {
			state: "OPEN",
			headSha: "sha1",
			mergeable: "MERGEABLE",
			reviewDecision: "",
			checks: "none",
			failedChecks: [],
			feedback: [
				{ id: "1", kind: "comment", author: "bob", isBot: false, at: "2026-11-19T11:00:00Z", body: "new" },
			],
		};
		const result = diffSnapshot(prev, snap, { now: 0, automerge: false });
		expect(result.events).toEqual([{ kind: "review_feedback", items: snap.feedback }]);
		expect(result.next.feedbackSeenAt).toBe("2026-11-19T11:00:00Z");

		const repeat = diffSnapshot(result.next, snap, { now: 1000, automerge: false });
		expect(repeat.events).toEqual([]);
	});

	test("first snapshot seeds feedbackSeenAt from history without a review_feedback wake", () => {
		const snap: Snapshot = {
			state: "OPEN",
			headSha: "sha1",
			mergeable: "MERGEABLE",
			reviewDecision: "",
			checks: "none",
			failedChecks: [],
			feedback: [
				{ id: "1", kind: "comment", author: "bob", isBot: false, at: "2026-11-19T11:00:00Z", body: "old" },
			],
		};
		const result = diffSnapshot(null, snap, { now: 0, automerge: false });
		expect(result.events.some((e) => e.kind === "review_feedback")).toBe(false);
		expect(result.next.feedbackSeenAt).toBe("2026-11-19T11:00:00Z");
	});

	test("ci_green fires on passed checks, no-fire on repeat, mergeAllowed reflects automerge/APPROVED", () => {
		const snap: Snapshot = {
			state: "OPEN",
			headSha: "sha1",
			mergeable: "MERGEABLE",
			reviewDecision: "",
			checks: "passed",
			failedChecks: [],
			feedback: [],
		};
		const notApproved = diffSnapshot(fp(), snap, { now: 0, automerge: false });
		expect(notApproved.events).toEqual([{ kind: "ci_green", mergeAllowed: false }]);

		const approvedSnap: Snapshot = { ...snap, reviewDecision: "APPROVED" };
		const approved = diffSnapshot(fp(), approvedSnap, { now: 0, automerge: false });
		expect(approved.events).toEqual([{ kind: "ci_green", mergeAllowed: true }]);

		const automerged = diffSnapshot(fp(), snap, { now: 0, automerge: true });
		expect(automerged.events).toEqual([{ kind: "ci_green", mergeAllowed: true }]);

		const repeat = diffSnapshot(notApproved.next, snap, { now: 1000, automerge: false });
		expect(repeat.events).toEqual([]);
	});

	test("ci_green does not fire while CONFLICTING", () => {
		const snap: Snapshot = {
			state: "OPEN",
			headSha: "sha1",
			mergeable: "CONFLICTING",
			reviewDecision: "",
			checks: "passed",
			failedChecks: [],
			feedback: [],
		};
		const result = diffSnapshot(fp(), snap, { now: 0, automerge: false });
		expect(result.events.some((e) => e.kind === "ci_green")).toBe(false);
	});

	test("new head sha re-arms ci_green", () => {
		const base = fp({ reportedGreenSha: "sha1" });
		const snap: Snapshot = {
			state: "OPEN",
			headSha: "sha2",
			mergeable: "MERGEABLE",
			reviewDecision: "",
			checks: "passed",
			failedChecks: [],
			feedback: [],
		};
		const result = diffSnapshot(base, snap, { now: 0, automerge: false });
		expect(result.events).toEqual([{ kind: "ci_green", mergeAllowed: false }]);
	});

	test("no-CI settle: empty rollup does not fire ci_green before 5 minutes, fires after", () => {
		const snap: Snapshot = {
			state: "OPEN",
			headSha: "sha1",
			mergeable: "MERGEABLE",
			reviewDecision: "",
			checks: "none",
			failedChecks: [],
			feedback: [],
		};
		const seen = diffSnapshot(fp(), snap, { now: 0, automerge: false });
		expect(seen.next.noChecksSince).toEqual({ sha: "sha1", at: 0 });
		expect(seen.events.some((e) => e.kind === "ci_green")).toBe(false);

		const tooSoon = diffSnapshot(seen.next, snap, { now: NO_CHECKS_SETTLE_MS - 1, automerge: false });
		expect(tooSoon.events.some((e) => e.kind === "ci_green")).toBe(false);

		const settled = diffSnapshot(seen.next, snap, { now: NO_CHECKS_SETTLE_MS, automerge: false });
		expect(settled.events).toEqual([{ kind: "ci_green", mergeAllowed: false }]);
	});

	test("no-CI settle clock resets on a new head sha", () => {
		const base = fp({ noChecksSince: { sha: "sha1", at: 0 } });
		const snap: Snapshot = {
			state: "OPEN",
			headSha: "sha2",
			mergeable: "MERGEABLE",
			reviewDecision: "",
			checks: "none",
			failedChecks: [],
			feedback: [],
		};
		const result = diffSnapshot(base, snap, { now: NO_CHECKS_SETTLE_MS, automerge: false });
		expect(result.next.noChecksSince).toEqual({ sha: "sha2", at: NO_CHECKS_SETTLE_MS });
		expect(result.events.some((e) => e.kind === "ci_green")).toBe(false);
	});

	test("closed suppresses all other events", () => {
		const prev = fp({ mergeable: "MERGEABLE" });
		const snap: Snapshot = {
			state: "MERGED",
			headSha: "sha2",
			mergeable: "CONFLICTING",
			reviewDecision: "",
			checks: "failed",
			failedChecks: [{ name: "lint" }],
			feedback: [
				{ id: "1", kind: "comment", author: "bob", isBot: false, at: "2026-11-19T11:00:00Z", body: "x" },
			],
		};
		const result = diffSnapshot(prev, snap, { now: 0, automerge: false });
		expect(result.events).toEqual([{ kind: "closed", state: "MERGED" }]);
	});

	test("coalesces multiple events from one snapshot, in order ci_failed, conflict, review_feedback, ci_green", () => {
		const prev = fp({ feedbackSeenAt: "2026-11-19T09:00:00Z" });
		const snap: Snapshot = {
			state: "OPEN",
			headSha: "sha1",
			mergeable: "CONFLICTING",
			reviewDecision: "",
			checks: "failed",
			failedChecks: [{ name: "lint" }],
			feedback: [
				{ id: "1", kind: "comment", author: "bob", isBot: false, at: "2026-11-19T10:00:00Z", body: "x" },
			],
		};
		const result = diffSnapshot(prev, snap, { now: 0, automerge: false });
		expect(result.events.map((e) => e.kind)).toEqual(["ci_failed", "conflict", "review_feedback"]);
	});
});

describe("wakeText", () => {
	test("states merging IS authorized for mergeAllowed ci_green", () => {
		const snap: Snapshot = {
			state: "OPEN",
			headSha: "sha1",
			mergeable: "MERGEABLE",
			reviewDecision: "APPROVED",
			checks: "passed",
			failedChecks: [],
			feedback: [],
		};
		const text = wakeText(URL, [{ kind: "ci_green", mergeAllowed: true }], snap);
		expect(text).toContain("Merging is authorized");
		expect(text).toContain("gh pr merge");
		expect(text).not.toContain("do NOT merge");
	});

	test("states merging is NOT authorized for non-mergeAllowed ci_green", () => {
		const snap: Snapshot = {
			state: "OPEN",
			headSha: "sha1",
			mergeable: "MERGEABLE",
			reviewDecision: "",
			checks: "passed",
			failedChecks: [],
			feedback: [],
		};
		const text = wakeText(URL, [{ kind: "ci_green", mergeAllowed: false }], snap);
		expect(text).toContain("Merging is NOT authorized");
		expect(text).toContain("do NOT merge");
	});

	test("truncates feedback bodies over 500 chars and caps list at 10 with a remainder note", () => {
		const longBody = "x".repeat(600);
		const items = Array.from({ length: 12 }, (_, i) => ({
			id: String(i),
			kind: "comment" as const,
			author: "bob",
			isBot: false,
			at: `2026-11-19T10:${String(i).padStart(2, "0")}:00Z`,
			body: i === 0 ? longBody : "short",
		}));
		const snap: Snapshot = {
			state: "OPEN",
			headSha: "sha1",
			mergeable: "MERGEABLE",
			reviewDecision: "",
			checks: "none",
			failedChecks: [],
			feedback: items,
		};
		const text = wakeText(URL, [{ kind: "review_feedback", items }], snap);
		expect(text).toContain(`${"x".repeat(500)}...`);
		expect(text).not.toContain("x".repeat(501));
		expect(text).toContain("+2 more");
	});

	test("includes failed check names and urls for ci_failed", () => {
		const snap: Snapshot = {
			state: "OPEN",
			headSha: "sha1",
			mergeable: "MERGEABLE",
			reviewDecision: "",
			checks: "failed",
			failedChecks: [{ name: "lint", url: "https://x/1" }],
			feedback: [],
		};
		const text = wakeText(URL, [{ kind: "ci_failed", checks: [{ name: "lint", url: "https://x/1" }] }], snap);
		expect(text).toContain("lint");
		expect(text).toContain("https://x/1");
	});

	test("closed event omits the still-watching footer", () => {
		const snap: Snapshot = {
			state: "MERGED",
			headSha: "sha1",
			mergeable: "MERGEABLE",
			reviewDecision: "",
			checks: "none",
			failedChecks: [],
			feedback: [],
		};
		const text = wakeText(URL, [{ kind: "closed", state: "MERGED" }], snap);
		expect(text).toContain("merged");
		expect(text).not.toContain("still being watched");
	});
});

describe("haltText", () => {
	test("tells the agent to stop, pin a T sticky note, and that wakes resume later", () => {
		const text = haltText(URL, 3);
		expect(text).toContain(URL);
		expect(text.toLowerCase()).toContain("stop");
		expect(text).toContain("sticky_notes");
		expect(text).toContain("`T`");
		expect(text.toLowerCase()).toContain("resume");
	});
});

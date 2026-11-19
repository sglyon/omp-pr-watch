// Pure: gh JSON -> Snapshot; (prev Fingerprint, Snapshot, now) -> { events, next Fingerprint }; wake/halt text.
// No omp imports; tolerant of missing/unknown fields in gh output.

import type {
	ChecksState,
	FailedCheck,
	Feedback,
	Fingerprint,
	Mergeable,
	PrEvent,
	PrState,
	Snapshot,
} from "./types";
import { NO_CHECKS_SETTLE_MS } from "./types";

type AnyRecord = Record<string, any>;

const FAIL_CONCLUSIONS: Record<string, true> = {
	FAILURE: true,
	TIMED_OUT: true,
	CANCELLED: true,
	ACTION_REQUIRED: true,
	STARTUP_FAILURE: true,
};

function isBotLogin(login: string): boolean {
	return login.toLowerCase().endsWith("[bot]");
}

function computeChecks(rollup: AnyRecord[]): { checks: ChecksState; failedChecks: FailedCheck[] } {
	if (rollup.length === 0) return { checks: "none", failedChecks: [] };

	// Dedupe CheckRuns by name, keeping the one with the latest startedAt (re-runs appear twice).
	const checkRunsByName = new Map<string, AnyRecord>();
	const statusContexts: AnyRecord[] = [];
	for (const item of rollup) {
		if (!item || typeof item !== "object") continue;
		if (item.__typename === "CheckRun") {
			const name = typeof item.name === "string" ? item.name : "";
			const existing = checkRunsByName.get(name);
			const startedAt = typeof item.startedAt === "string" ? item.startedAt : "";
			const existingStartedAt = existing && typeof existing.startedAt === "string" ? existing.startedAt : "";
			if (!existing || startedAt > existingStartedAt) checkRunsByName.set(name, item);
		} else if (item.__typename === "StatusContext") {
			statusContexts.push(item);
		}
	}

	const checkRuns = [...checkRunsByName.values()];

	for (const cr of checkRuns) {
		if (cr.status !== "COMPLETED") return { checks: "pending", failedChecks: [] };
	}
	for (const sc of statusContexts) {
		if (sc.state === "EXPECTED" || sc.state === "PENDING") return { checks: "pending", failedChecks: [] };
	}

	const failedChecks: FailedCheck[] = [];
	for (const cr of checkRuns) {
		if (FAIL_CONCLUSIONS[cr.conclusion]) {
			failedChecks.push({ name: typeof cr.name === "string" ? cr.name : "", url: cr.detailsUrl ?? undefined });
		}
	}
	for (const sc of statusContexts) {
		if (sc.state === "FAILURE" || sc.state === "ERROR") {
			failedChecks.push({ name: typeof sc.context === "string" ? sc.context : "", url: sc.targetUrl ?? undefined });
		}
	}

	if (failedChecks.length > 0) return { checks: "failed", failedChecks };
	return { checks: "passed", failedChecks: [] };
}

export function toSnapshot(view: unknown, reviewComments: unknown, selfLogin: string): Snapshot {
	const v = (view && typeof view === "object" ? view : {}) as AnyRecord;
	const state: PrState = v.state === "MERGED" || v.state === "CLOSED" ? v.state : "OPEN";
	const headSha = typeof v.headRefOid === "string" ? v.headRefOid : "";
	const mergeable: Mergeable =
		v.mergeable === "MERGEABLE" || v.mergeable === "CONFLICTING" ? v.mergeable : "UNKNOWN";
	const reviewDecision = typeof v.reviewDecision === "string" ? v.reviewDecision : "";

	const rollup = Array.isArray(v.statusCheckRollup) ? v.statusCheckRollup : [];
	const { checks, failedChecks } = computeChecks(rollup);

	const selfLower = selfLogin.toLowerCase();
	const feedback: Feedback[] = [];

	for (const r of Array.isArray(v.reviews) ? v.reviews : []) {
		const author = r?.author?.login;
		if (typeof author !== "string" || author.length === 0 || author.toLowerCase() === selfLower) continue;
		const body = typeof r.body === "string" ? r.body : "";
		const rstate = typeof r.state === "string" ? r.state : undefined;
		if (body === "" && rstate === "COMMENTED") continue; // container for inline comments only
		const at = typeof r.submittedAt === "string" ? r.submittedAt : "";
		feedback.push({
			id: typeof r.id === "string" ? r.id : `review:${author}:${at}`,
			kind: "review",
			author,
			isBot: isBotLogin(author),
			at,
			body,
			state: rstate,
		});
	}

	for (const c of Array.isArray(v.comments) ? v.comments : []) {
		const author = c?.author?.login;
		if (typeof author !== "string" || author.length === 0 || author.toLowerCase() === selfLower) continue;
		const at = typeof c.createdAt === "string" ? c.createdAt : "";
		feedback.push({
			id: typeof c.id === "string" ? c.id : `comment:${author}:${at}`,
			kind: "comment",
			author,
			isBot: isBotLogin(author),
			at,
			body: typeof c.body === "string" ? c.body : "",
			url: typeof c.url === "string" ? c.url : undefined,
		});
	}

	for (const rc of Array.isArray(reviewComments) ? reviewComments : []) {
		const r = (rc ?? {}) as AnyRecord;
		const author = r?.user?.login;
		if (typeof author !== "string" || author.length === 0 || author.toLowerCase() === selfLower) continue;
		const isBot = r?.user?.type === "Bot" || isBotLogin(author);
		const at = typeof r.created_at === "string" ? r.created_at : "";
		feedback.push({
			id: r.id !== undefined && r.id !== null ? String(r.id) : `review_comment:${author}:${at}`,
			kind: "review_comment",
			author,
			isBot,
			at,
			body: typeof r.body === "string" ? r.body : "",
			url: typeof r.html_url === "string" ? r.html_url : undefined,
			path: typeof r.path === "string" ? r.path : undefined,
		});
	}

	feedback.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

	return { state, headSha, mergeable, reviewDecision, checks, failedChecks, feedback };
}

export function diffSnapshot(
	prev: Fingerprint | null,
	snap: Snapshot,
	opts: { now: number; automerge: boolean },
): { events: PrEvent[]; next: Fingerprint } {
	const { now, automerge } = opts;

	if (snap.state !== "OPEN") {
		const next: Fingerprint = {
			state: snap.state,
			headSha: snap.headSha,
			mergeable: snap.mergeable,
			feedbackSeenAt: prev?.feedbackSeenAt ?? "",
			reportedFailSha: prev?.reportedFailSha,
			reportedGreenSha: prev?.reportedGreenSha,
			reportedGreenAllowed: prev?.reportedGreenAllowed,
			noChecksSince: prev?.noChecksSince,
		};
		return { events: [{ kind: "closed", state: snap.state }], next };
	}

	const isFirst = prev === null;
	const events: PrEvent[] = [];

	// Seed feedbackSeenAt to the newest existing item on first snapshot; no wake for history.
	let feedbackSeenAt = prev?.feedbackSeenAt ?? "";
	if (isFirst) {
		for (const f of snap.feedback) if (f.at > feedbackSeenAt) feedbackSeenAt = f.at;
	}

	// No-CI settling: keep the same {sha, at} while the head SHA matches; reset on a new SHA;
	// clear once checks are no longer empty.
	let noChecksSince = prev?.noChecksSince;
	if (snap.checks === "none") {
		if (!noChecksSince || noChecksSince.sha !== snap.headSha) noChecksSince = { sha: snap.headSha, at: now };
	} else {
		noChecksSince = undefined;
	}

	let reportedFailSha = prev?.reportedFailSha;
	if (snap.checks === "failed" && reportedFailSha !== snap.headSha) {
		events.push({ kind: "ci_failed", checks: snap.failedChecks });
		reportedFailSha = snap.headSha;
	}

	if (snap.mergeable === "CONFLICTING" && prev?.mergeable !== "CONFLICTING") {
		events.push({ kind: "conflict" });
	}

	if (!isFirst) {
		const newItems = snap.feedback.filter((f) => f.at > feedbackSeenAt);
		if (newItems.length > 0) {
			events.push({ kind: "review_feedback", items: newItems });
			for (const f of newItems) if (f.at > feedbackSeenAt) feedbackSeenAt = f.at;
		}
	}

	let reportedGreenSha = prev?.reportedGreenSha;
	let reportedGreenAllowed = prev?.reportedGreenAllowed;
	const settledNone =
		snap.checks === "none" &&
		noChecksSince?.sha === snap.headSha &&
		now - noChecksSince.at >= NO_CHECKS_SETTLE_MS;
	const effectivePassed = snap.checks === "passed" || settledNone;
	const mergeAllowed = automerge || snap.reviewDecision === "APPROVED";
	const greenUnreported = reportedGreenSha !== snap.headSha;
	const newlyAuthorized = !greenUnreported && mergeAllowed && !reportedGreenAllowed;
	if (effectivePassed && snap.mergeable !== "CONFLICTING" && (greenUnreported || newlyAuthorized)) {
		events.push({ kind: "ci_green", mergeAllowed });
		reportedGreenSha = snap.headSha;
		reportedGreenAllowed = mergeAllowed;
	}

	const next: Fingerprint = {
		state: snap.state,
		headSha: snap.headSha,
		mergeable: snap.mergeable,
		feedbackSeenAt,
		reportedFailSha,
		reportedGreenSha,
		reportedGreenAllowed,
		noChecksSince,
	};

	return { events, next };
}

export function wakeText(url: string, events: PrEvent[], _snap: Snapshot): string {
	const lines: string[] = [`[pr-watch] ${url}`];

	for (const event of events) {
		lines.push("");
		switch (event.kind) {
			case "closed": {
				lines.push(event.state === "MERGED" ? "PR merged." : "PR closed without merging.");
				lines.push("Report the outcome to the user. No action needed; this PR is no longer tracked.");
				break;
			}
			case "ci_failed": {
				lines.push("CI failed:");
				for (const c of event.checks) lines.push(`- ${c.name}${c.url ? ` (${c.url})` : ""}`);
				lines.push(
					`Investigate with \`gh pr checks ${url}\` and \`gh run view <run-id> --log-failed\`, fix the failure, then push.`,
				);
				break;
			}
			case "conflict": {
				lines.push("Merge conflict with the base branch.");
				lines.push("Update from the base branch, resolve the conflict, then push.");
				break;
			}
			case "review_feedback": {
				lines.push("New review feedback:");
				const shown = event.items.slice(0, 10);
				for (const f of shown) {
					const tags = [f.kind, ...(f.state ? [f.state] : []), ...(f.path ? [f.path] : [])].join(" ");
					const body = f.body.length > 500 ? `${f.body.slice(0, 500)}...` : f.body;
					lines.push(`- ${f.author} (${tags}): ${body}`);
				}
				if (event.items.length > 10) lines.push(`+${event.items.length - 10} more`);
				lines.push("Address the feedback, push, then reply on the PR.");
				break;
			}
			case "ci_green": {
				lines.push("Checks are green.");
				if (event.mergeAllowed) {
					lines.push(
						`Merging is authorized. Merge with \`gh pr merge ${url} --delete-branch\` using the repo's allowed merge method (prefer --squash), then report the result.`,
					);
				} else {
					lines.push("Merging is NOT authorized. Report ready-to-merge to the user and stop; do NOT merge.");
				}
				break;
			}
		}
	}

	if (!events.some((e) => e.kind === "closed")) {
		lines.push("");
		lines.push("This PR is still being watched; pr-watch will wake you again on its next status change.");
	}

	return lines.join("\n");
}

export function haltText(url: string, wakes: number): string {
	return [
		`[pr-watch] ${url}`,
		"",
		`Stopping automatic action on this PR after ${wakes} action wakes with no resolution: the same failure keeps recurring.`,
		"Summarize the failure loop for the user: what keeps failing and what was already tried.",
		"Pin a `T` sticky note with the sticky_notes tool asking the user to take over this PR.",
		"",
		"pr-watch will resume waking you on this PR after the user's next prompt.",
	].join("\n");
}

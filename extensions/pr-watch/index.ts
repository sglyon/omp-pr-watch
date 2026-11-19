// Wiring: hooks, `/pr-watch` command, state persistence, wake delivery, loop guard.
// Pure logic lives in detect.ts/snapshot.ts/gh.ts/listener.ts; this file only coordinates them.

import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@oh-my-pi/pi-coding-agent";
import { extractCreatedPrUrls, parsePrUrl } from "./detect";
import { fetchPr, fetchSelfLogin, eventsAvailable } from "./gh";
import { startListener, type ListenerHandle } from "./listener";
import { diffSnapshot, haltText, toSnapshot, wakeText } from "./snapshot";
import {
	EVENT_DEBOUNCE_MS,
	EVENT_TYPES,
	MAX_ACTION_WAKES,
	POLL_MS,
	RECONCILE_MS,
	STATE_ENTRY_TYPE,
	WAKE_MESSAGE_TYPE,
	type PersistedState,
	type PrEvent,
	type Snapshot,
	type TrackedPr,
} from "./types";

const TICK_MS = 30_000;
const ERROR_NOTIFY_MS = 60 * 60_000;

// Module-scope: the module is imported once per process; the factory re-runs per session
// (main + every subagent). A subagent instance has no listeners/timers of its own, so it
// queues URLs here and asks whichever main instance is currently registered to drain them.
const subagentPrQueue: string[] = [];
let mainController: { drain(): void } | undefined;

function isPersistedState(data: unknown): data is PersistedState {
	return !!data && typeof data === "object" && (data as PersistedState).version === 1 && Array.isArray((data as PersistedState).prs);
}

function isTrackedPrLike(x: unknown): x is TrackedPr {
	return !!x && typeof x === "object" && typeof (x as TrackedPr).url === "string";
}

/** omp v19 adds `agent` (kind "main" | "sub") to ExtensionContext; the installed package's v17
 * types don't declare it yet (confirmed present at runtime, see runtime-probe.md Q2). */
interface ExtensionContextWithAgent extends ExtensionContext {
	agent: { kind: "main" | "sub"; id?: string };
}

function agentKind(ctx: ExtensionContext): "main" | "sub" {
	const withAgent = ctx as ExtensionContextWithAgent; // v19 runtime field, see interface doc above
	return withAgent.agent.kind;
}

/** omp v19 adds `reason` to before_agent_start's event; absent from the installed v17 types
 * (confirmed present at runtime, see runtime-probe.md Q3). */
interface BeforeAgentStartEventWithReason {
	reason?: string;
}

/** omp v19 lets `tool_result` handlers return model-visible `additionalContext`; the installed
 * v17 types' `ToolResultEventResult` doesn't declare it yet. */
interface ToolResultWithAdditionalContext {
	additionalContext?: string;
}

export default function prWatch(pi: ExtensionAPI) {
	const prs = new Map<string, TrackedPr>();
	const listeners = new Map<string, ListenerHandle>();
	const pollOnly = new Set<string>();
	const lastSnapshotAt = new Map<string, number>();
	const lastSnapshots = new Map<string, Snapshot>();
	const inFlight = new Set<string>();
	const debounceTimers = new Map<string, Timer>();
	const lastErrorNotifyAt = new Map<string, number>();

	let mode: "events" | "poll" = "poll";
	let selfLogin: string | undefined;
	let selfLoginPromise: Promise<string> | undefined;
	let tickTimer: Timer | undefined;
	let currentCtx: ExtensionContext | undefined;
	let accountUnavailableNotified = false;

	const ownController = { drain: drainQueue };

	function persist(): void {
		const data: PersistedState = { version: 1, prs: [...prs.values()] };
		pi.appendEntry(STATE_ENTRY_TYPE, data);
	}

	function restore(ctx: ExtensionContext): void {
		let data: unknown;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE) data = entry.data;
		}
		prs.clear();
		if (!isPersistedState(data)) return;
		for (const raw of data.prs) {
			if (!isTrackedPrLike(raw)) continue;
			prs.set(raw.url, {
				url: raw.url,
				automerge: !!raw.automerge,
				fp: raw.fp ?? null,
				wakes: typeof raw.wakes === "number" ? raw.wakes : 0,
				halted: !!raw.halted,
			});
		}
	}

	function stopAllListeners(): void {
		for (const handle of listeners.values()) handle.stop();
		listeners.clear();
		for (const timer of debounceTimers.values()) currentCtx?.clearTimer(timer);
		debounceTimers.clear();
	}

	function scheduleDebouncedSnapshot(url: string): void {
		if (!currentCtx) return;
		const existing = debounceTimers.get(url);
		if (existing) currentCtx.clearTimer(existing);
		const timer = currentCtx.setTimeout(() => {
			debounceTimers.delete(url);
			void snapshot(url);
		}, EVENT_DEBOUNCE_MS);
		debounceTimers.set(url, timer);
	}

	function startListenerFor(url: string): void {
		if (listeners.has(url)) return;
		const handle = startListener({
			url,
			eventTypes: EVENT_TYPES,
			onSignal: () => scheduleDebouncedSnapshot(url),
			onUnavailable: (scope) => {
				if (scope === "account") {
					mode = "poll";
					stopAllListeners();
					if (!accountUnavailableNotified) {
						accountUnavailableNotified = true;
						try {
							currentCtx?.ui.notify("pr-watch: gh event subscriptions unavailable (account); polling every 2 min", "info");
						} catch {
							// UI unavailable; nothing to do.
						}
					}
				} else {
					pollOnly.add(url);
					listeners.delete(url);
				}
			},
		});
		listeners.set(url, handle);
	}

	function trackUrl(url: string, automerge: boolean): boolean {
		if (prs.has(url)) return false;
		prs.set(url, { url, automerge, fp: null, wakes: 0, halted: false });
		if (mode === "events") startListenerFor(url);
		return true;
	}

	function untrackUrl(url: string): boolean {
		const existed = prs.delete(url);
		const handle = listeners.get(url);
		if (handle) {
			handle.stop();
			listeners.delete(url);
		}
		const timer = debounceTimers.get(url);
		if (timer) {
			currentCtx?.clearTimer(timer);
			debounceTimers.delete(url);
		}
		lastSnapshotAt.delete(url);
		lastSnapshots.delete(url);
		pollOnly.delete(url);
		inFlight.delete(url);
		lastErrorNotifyAt.delete(url);
		if (existed) persist();
		return existed;
	}

	function drainQueue(): void {
		let changed = false;
		for (;;) {
			const raw = subagentPrQueue.shift();
			if (raw === undefined) break;
			const ref = parsePrUrl(raw);
			const canon = ref ? ref.url : raw;
			if (trackUrl(canon, false)) {
				changed = true;
				void snapshot(canon);
			}
		}
		if (changed) persist();
	}

	function sendWake(content: string): void {
		if (!currentCtx) return;
		const idle = currentCtx.isIdle();
		if (idle) {
			pi.sendMessage({ customType: WAKE_MESSAGE_TYPE, content, display: true }, { triggerTurn: true });
		} else {
			pi.sendMessage({ customType: WAKE_MESSAGE_TYPE, content, display: true }, { triggerTurn: true, deliverAs: "followUp" });
		}
	}

	async function handleEvents(url: string, pr: TrackedPr, events: PrEvent[], snap: Snapshot): Promise<void> {
		if (events.some((e) => e.kind === "closed")) {
			sendWake(wakeText(url, events, snap));
			untrackUrl(url);
			return;
		}
		if (pr.halted) return;
		if (pr.wakes >= MAX_ACTION_WAKES) {
			sendWake(haltText(url, pr.wakes));
			pr.halted = true;
			persist();
			return;
		}
		pr.wakes++;
		persist();
		sendWake(wakeText(url, events, snap));
	}

	async function snapshot(url: string): Promise<void> {
		if (!currentCtx) return;
		if (inFlight.has(url)) return;
		if (!prs.has(url)) return;
		inFlight.add(url);
		try {
			if (selfLogin === undefined) {
				// A failed lookup (offline, auth blip) must not be cached for the whole session.
				selfLoginPromise ??= fetchSelfLogin(pi.exec).catch((err: unknown) => {
					selfLoginPromise = undefined;
					throw err;
				});
				selfLogin = await selfLoginPromise;
			}
			const ref = parsePrUrl(url);
			if (!ref) return;
			const { view, reviewComments } = await fetchPr(pi.exec, ref);
			const pr = prs.get(url);
			if (!pr) return; // untracked while fetching
			const snap = toSnapshot(view, reviewComments, selfLogin);
			const { events, next } = diffSnapshot(pr.fp, snap, { now: Date.now(), automerge: pr.automerge });
			const prAfter = prs.get(url);
			if (!prAfter) return; // untracked while diffing
			lastSnapshotAt.set(url, Date.now());
			lastSnapshots.set(url, snap);
			const fpChanged = JSON.stringify(prAfter.fp) !== JSON.stringify(next);
			prAfter.fp = next;
			if (fpChanged || events.length > 0) persist();
			if (events.length > 0) await handleEvents(url, prAfter, events, snap);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const lastNotify = lastErrorNotifyAt.get(url) ?? 0;
			if (Date.now() - lastNotify >= ERROR_NOTIFY_MS) {
				lastErrorNotifyAt.set(url, Date.now());
				try {
					currentCtx?.ui.notify(`pr-watch: ${url}: ${message}`, "warning");
				} catch {
					// UI unavailable; nothing to do.
				}
			}
		} finally {
			inFlight.delete(url);
		}
	}

	function tick(): void {
		if (!currentCtx) return;
		drainQueue();
		const now = Date.now();
		for (const url of prs.keys()) {
			const last = lastSnapshotAt.get(url);
			const poll = mode === "poll" || pollOnly.has(url);
			const due = last === undefined || (poll && now - last >= POLL_MS) || now - last >= RECONCILE_MS;
			if (due) void snapshot(url);
		}
	}

	async function startupMain(ctx: ExtensionContext): Promise<void> {
		stopAllListeners();
		if (tickTimer) {
			currentCtx?.clearTimer(tickTimer);
			tickTimer = undefined;
		}
		currentCtx = ctx;
		accountUnavailableNotified = false;
		pollOnly.clear();
		lastSnapshotAt.clear();
		lastSnapshots.clear();
		restore(ctx);
		try {
			mode = (await eventsAvailable(pi.exec)) ? "events" : "poll";
		} catch {
			mode = "poll";
		}
		if (mode === "events") {
			for (const url of prs.keys()) startListenerFor(url);
		}
		tickTimer = ctx.setInterval(() => tick(), TICK_MS);
		mainController = ownController;
		for (const url of prs.keys()) void snapshot(url);
	}

	function resetLoopGuards(): boolean {
		let changed = false;
		for (const pr of prs.values()) {
			if (pr.wakes !== 0 || pr.halted) {
				pr.wakes = 0;
				pr.halted = false;
				changed = true;
			}
		}
		return changed;
	}

	function listPrs(ctx: ExtensionContext): void {
		if (prs.size === 0) {
			ctx.ui.notify("pr-watch: no tracked PRs", "info");
			return;
		}
		const lines: string[] = [];
		for (const [url, pr] of prs) {
			const snap = lastSnapshots.get(url);
			const checks = snap?.checks ?? "?";
			const mergeable = snap?.mergeable ?? "?";
			const automerge = pr.automerge ? "yes" : "no";
			const halted = pr.halted ? " HALTED" : "";
			lines.push(`${url}  checks=${checks} mergeable=${mergeable} automerge=${automerge} wakes=${pr.wakes}${halted}`);
		}
		lines.push(`mode: ${mode === "events" ? "events" : "poll"}`);
		ctx.ui.notify(lines.join("\n"), "info");
	}

	pi.on("session_start", async (_event, ctx) => {
		if (agentKind(ctx) !== "main") return;
		await startupMain(ctx);
	});
	pi.on("session_switch", async (_event, ctx) => {
		if (agentKind(ctx) !== "main") return;
		await startupMain(ctx);
	});
	pi.on("session_branch", async (_event, ctx) => {
		if (agentKind(ctx) !== "main") return;
		await startupMain(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		if (agentKind(ctx) !== "main") return;
		await startupMain(ctx);
	});

	pi.on("session_shutdown", () => {
		stopAllListeners();
		if (tickTimer) {
			currentCtx?.clearTimer(tickTimer);
			tickTimer = undefined;
		}
		if (mainController === ownController) mainController = undefined;
	});

	function handleToolResult(event: ToolResultEvent, ctx: ExtensionContext): ToolResultWithAdditionalContext | undefined {
		try {
			const urls = extractCreatedPrUrls(event);
			if (urls.length === 0) return undefined;

			if (agentKind(ctx) !== "main") {
				for (const raw of urls) {
					const ref = parsePrUrl(raw);
					subagentPrQueue.push(ref ? ref.url : raw);
				}
				try {
					mainController?.drain();
				} catch {
					// Main instance not ready; the periodic tick will drain it.
				}
				return undefined;
			}

			let trackedUrl: string | undefined;
			for (const raw of urls) {
				const ref = parsePrUrl(raw);
				const canon = ref ? ref.url : raw;
				if (trackUrl(canon, false)) {
					trackedUrl = canon;
					void snapshot(canon);
				}
			}
			if (trackedUrl === undefined) return undefined;
			persist();
			return {
				additionalContext: `[pr-watch] Now tracking ${trackedUrl}; this session will be woken when CI, reviews, conflicts, or merge state need action.`,
			};
		} catch {
			return undefined;
		}
	}
	// v19 tool_result handlers may return additionalContext (see ToolResultWithAdditionalContext doc above);
	// cast once here rather than fighting the installed v17 handler-result type on every return.
	const onToolResult = pi.on as (event: "tool_result", handler: typeof handleToolResult) => void;
	onToolResult("tool_result", handleToolResult);

	pi.on("before_agent_start", (event, ctx) => {
		if (agentKind(ctx) !== "main") return;
		const withReason = event as BeforeAgentStartEventWithReason & typeof event;
		if (withReason.reason !== "prompt") return;
		if (resetLoopGuards()) persist();
	});

	pi.on("input", (event, ctx) => {
		if (agentKind(ctx) !== "main") return;
		if (event.source !== "interactive" && event.source !== "rpc") return;
		if (resetLoopGuards()) persist();
	});

	pi.registerCommand("pr-watch", {
		description: "Track PRs: /pr-watch [<url> [--automerge]] | rm <url>",
		handler: async (args, ctx) => {
			if (agentKind(ctx) !== "main") {
				ctx.ui.notify("pr-watch: only available in the main session", "warning");
				return;
			}
			const trimmed = args.trim();
			if (trimmed.length === 0) {
				listPrs(ctx);
				return;
			}

			const parts = trimmed.split(/\s+/);
			if (parts[0] === "rm") {
				const target = parts[1];
				const ref = target ? parsePrUrl(target) : null;
				if (!target || !ref) {
					ctx.ui.notify("Usage: /pr-watch rm <url>", "warning");
					return;
				}
				const existed = untrackUrl(ref.url);
				ctx.ui.notify(existed ? `pr-watch: stopped tracking ${ref.url}` : `pr-watch: ${ref.url} was not tracked`, "info");
				return;
			}

			const automergeFlag = parts.includes("--automerge");
			const urlArg = parts.find((p) => p !== "--automerge");
			const ref = urlArg ? parsePrUrl(urlArg) : null;
			if (!ref) {
				ctx.ui.notify("Usage: /pr-watch [<url> [--automerge]] | rm <url>", "warning");
				return;
			}

			const existing = prs.get(ref.url);
			if (existing) {
				if (automergeFlag) existing.automerge = true;
				persist();
			} else {
				trackUrl(ref.url, automergeFlag);
				persist();
				void snapshot(ref.url);
			}
			const automerge = prs.get(ref.url)?.automerge ? "on" : "off";
			ctx.ui.notify(`pr-watch: tracking ${ref.url} (automerge ${automerge}, ${mode === "events" ? "events" : "polling"})`, "info");
		},
	});
}

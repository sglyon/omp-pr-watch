import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { eventsAvailable, fetchPr, fetchSelfLogin } from "../extensions/pr-watch/gh";
import { startListener } from "../extensions/pr-watch/listener";
import type { Exec, PrRef } from "../extensions/pr-watch/types";

const FAKE_GH = path.join(import.meta.dir, "fixtures/fake-gh.sh");
const EVENT_TYPES = ["com.github.pull_request.state.changed.v1", "com.github.pull_request.head.changed.v1"];

// Real wall-clock waits are unavoidable here: these are integration tests against real
// `Bun.spawn` child processes communicating over real OS pipes, plus listener.ts's own
// real `setTimeout` backoff. There is no event to `await` instead — we are asserting on
// the actual async process/timer behavior itself.
function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

const openHandles: Array<{ stop(): void }> = [];

afterEach(() => {
	for (const handle of openHandles.splice(0)) handle.stop();
	delete process.env.FAKE_GH_MODE;
});

describe("startListener", () => {
	test("events mode: attaches then signals two events", async () => {
		process.env.FAKE_GH_MODE = "events";
		const signals: string[] = [];
		const handle = startListener({
			url: "https://github.com/octo-org/widgets/pull/1",
			eventTypes: EVENT_TYPES,
			onSignal: (reason) => signals.push(reason),
			onUnavailable: () => {
				throw new Error("unexpected onUnavailable");
			},
			command: ["bash", FAKE_GH],
		});
		openHandles.push(handle);

		await sleep(400);
		expect(signals[0]).toBe("attached");
		expect(signals.slice(1)).toEqual(["event", "event"]);
		expect(handle.running).toBe(true);
	});

	test("forbidden mode: account unavailable, no restart", async () => {
		process.env.FAKE_GH_MODE = "forbidden";
		const unavailable: Array<[string, string]> = [];
		const signals: string[] = [];
		const handle = startListener({
			url: "https://github.com/octo-org/widgets/pull/2",
			eventTypes: EVENT_TYPES,
			onSignal: (reason) => signals.push(reason),
			onUnavailable: (scope, detail) => unavailable.push([scope, detail]),
			command: ["bash", FAKE_GH],
			backoffMs: [20, 20, 20],
		});
		openHandles.push(handle);

		await sleep(300);
		expect(unavailable).toHaveLength(1);
		expect(unavailable[0][0]).toBe("account");
		expect(unavailable[0][1]).toContain("HTTP 403");
		expect(handle.running).toBe(false);

		const signalCountAfterHalt = signals.length;
		await sleep(300);
		expect(signals.length).toBe(signalCountAfterHalt);
		expect(unavailable).toHaveLength(1);
	});

	test("enterprise mode: pr unavailable, no restart", async () => {
		process.env.FAKE_GH_MODE = "enterprise";
		const unavailable: Array<[string, string]> = [];
		const handle = startListener({
			url: "https://ghe.example.com/octo-org/widgets/pull/3",
			eventTypes: EVENT_TYPES,
			onSignal: () => {},
			onUnavailable: (scope, detail) => unavailable.push([scope, detail]),
			command: ["bash", FAKE_GH],
			backoffMs: [20, 20, 20],
		});
		openHandles.push(handle);

		await sleep(300);
		expect(unavailable).toHaveLength(1);
		expect(unavailable[0][0]).toBe("pr");
		expect(handle.running).toBe(false);

		await sleep(300);
		expect(unavailable).toHaveLength(1);
	});

	test("exit mode: restarts twice then unavailable after 3 quick exits", async () => {
		process.env.FAKE_GH_MODE = "exit";
		const unavailable: Array<[string, string]> = [];
		const handle = startListener({
			url: "https://github.com/octo-org/widgets/pull/4",
			eventTypes: EVENT_TYPES,
			onSignal: () => {},
			onUnavailable: (scope, detail) => unavailable.push([scope, detail]),
			command: ["bash", FAKE_GH],
			backoffMs: [10, 10, 10],
		});
		openHandles.push(handle);

		await sleep(500);
		expect(unavailable).toHaveLength(1);
		expect(unavailable[0]).toEqual(["pr", "listener keeps exiting"]);
		expect(handle.running).toBe(false);
	});

	test("stop() kills the child and silences further signals", async () => {
		process.env.FAKE_GH_MODE = "events";
		const signals: string[] = [];
		const handle = startListener({
			url: "https://github.com/octo-org/widgets/pull/5",
			eventTypes: EVENT_TYPES,
			onSignal: (reason) => signals.push(reason),
			onUnavailable: () => {},
			command: ["bash", FAKE_GH],
		});

		await sleep(150);
		handle.stop();
		expect(handle.running).toBe(false);

		const signalCountAtStop = signals.length;
		expect(signalCountAtStop).toBeGreaterThan(0);
		await sleep(400);
		expect(signals.length).toBe(signalCountAtStop);
	});
});

describe("gh.ts", () => {
	const ref: PrRef = {
		host: "github.com",
		owner: "octo-org",
		repo: "widgets",
		number: 7,
		url: "https://github.com/octo-org/widgets/pull/7",
	};

	test("fetchPr builds the expected argv and ignores stderr", async () => {
		const calls: string[][] = [];
		const exec: Exec = async (_command, args) => {
			calls.push(args);
			if (args[0] === "pr") {
				return { stdout: JSON.stringify({ state: "OPEN" }), stderr: "hint: noisy", code: 0, killed: false };
			}
			return { stdout: JSON.stringify([{ id: 1 }]), stderr: "", code: 0, killed: false };
		};

		const result = await fetchPr(exec, ref);
		expect(result.view).toEqual({ state: "OPEN" });
		expect(result.reviewComments).toEqual([{ id: 1 }]);
		expect(calls).toContainEqual([
			"pr",
			"view",
			ref.url,
			"--json",
			"state,mergeable,reviewDecision,headRefOid,statusCheckRollup,reviews,comments",
		]);
		expect(calls).toContainEqual(["api", "repos/octo-org/widgets/pulls/7/comments", "--paginate"]);
	});

	test("fetchPr adds --hostname for enterprise hosts", async () => {
		const enterpriseRef: PrRef = {
			host: "ghe.example.com",
			owner: "octo-org",
			repo: "widgets",
			number: 9,
			url: "https://ghe.example.com/octo-org/widgets/pull/9",
		};
		const calls: string[][] = [];
		const exec: Exec = async (_command, args) => {
			calls.push(args);
			return { stdout: args[0] === "pr" ? "{}" : "[]", stderr: "", code: 0, killed: false };
		};

		await fetchPr(exec, enterpriseRef);
		expect(calls).toContainEqual([
			"api",
			"repos/octo-org/widgets/pulls/9/comments",
			"--paginate",
			"--hostname",
			"ghe.example.com",
		]);
	});

	test("fetchPr throws on non-zero exit, surfacing the first stderr line", async () => {
		const exec: Exec = async () => ({ stdout: "", stderr: "HTTP 404: Not Found\nmore detail", code: 1, killed: false });
		await expect(fetchPr(exec, ref)).rejects.toThrow(/HTTP 404/);
	});

	test("fetchPr throws on unparsable JSON", async () => {
		const exec: Exec = async (_command, args) => ({
			stdout: args[0] === "pr" ? "not json" : "[]",
			stderr: "",
			code: 0,
			killed: false,
		});
		await expect(fetchPr(exec, ref)).rejects.toThrow();
	});

	test("fetchSelfLogin trims stdout", async () => {
		const exec: Exec = async () => ({ stdout: "alice\n", stderr: "", code: 0, killed: false });
		expect(await fetchSelfLogin(exec)).toBe("alice");
	});

	test("eventsAvailable reflects the exit code", async () => {
		const ok: Exec = async () => ({ stdout: "", stderr: "", code: 0, killed: false });
		const bad: Exec = async () => ({ stdout: "", stderr: "command not found", code: 127, killed: false });
		expect(await eventsAvailable(ok)).toBe(true);
		expect(await eventsAvailable(bad)).toBe(false);
	});
});

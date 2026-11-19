// One `gh event listen --follow` child per PR: spawn, line reading, restart with backoff, kill.
// Pure process plumbing; event payloads are never interpreted, only their arrival matters.

export type ListenerOpts = {
	url: string;
	eventTypes: readonly string[];
	/** stdout line -> "event"; a stream-attached stderr status line -> "attached". */
	onSignal: (reason: "event" | "attached") => void;
	/** Permanent: caller switches the PR to poll mode. No further callbacks follow. */
	onUnavailable: (scope: "account" | "pr", detail: string) => void;
	onLog?: (msg: string) => void;
	/** Default `["gh"]`; tests pass `["bash", "<fake-gh.sh>"]`. */
	command?: string[];
	/** Default `[5_000, 30_000, 120_000, 300_000]`. */
	backoffMs?: number[];
	now?: () => number;
};

export type ListenerHandle = { stop(): void; readonly running: boolean };

const DEFAULT_BACKOFF_MS = [5_000, 30_000, 120_000, 300_000];
const EXIT_WINDOW_MS = 10 * 60_000;
const EXIT_WINDOW_LIMIT = 3;

function readLines(stream: ReadableStream<Uint8Array> | null | undefined, onLine: (line: string) => void): void {
	if (!stream) return;
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	void (async () => {
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let idx: number;
				while ((idx = buffer.indexOf("\n")) >= 0) {
					const line = buffer.slice(0, idx).replace(/\r$/, "");
					buffer = buffer.slice(idx + 1);
					if (line.length > 0) onLine(line);
				}
			}
			const tail = buffer.replace(/\r$/, "");
			if (tail.length > 0) onLine(tail);
		} catch {
			// Stream closed/errored alongside process exit; nothing to do.
		}
	})();
}

export function startListener(opts: ListenerOpts): ListenerHandle {
	const commandBase = opts.command ?? ["gh"];
	const backoff = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
	const now = opts.now ?? (() => Date.now());

	let stopped = false;
	let backoffIndex = 0;
	let restartTimer: ReturnType<typeof setTimeout> | null = null;
	let child: { kill(): void } | null = null;
	const noEventExits: number[] = [];

	const log = (msg: string) => {
		try {
			opts.onLog?.(msg);
		} catch {
			// never let a logging callback break the listener
		}
	};

	const safeSignal = (reason: "event" | "attached") => {
		try {
			opts.onSignal(reason);
		} catch {
			// swallow consumer errors
		}
	};

	const safeUnavailable = (scope: "account" | "pr", detail: string) => {
		try {
			opts.onUnavailable(scope, detail);
		} catch {
			// swallow consumer errors
		}
	};

	function haltPermanently(scope: "account" | "pr", detail: string) {
		if (stopped) return;
		stopped = true;
		if (restartTimer) {
			clearTimeout(restartTimer);
			restartTimer = null;
		}
		if (child) {
			try {
				child.kill();
			} catch {
				// already dead
			}
			child = null;
		}
		safeUnavailable(scope, detail);
	}

	function scheduleRestart() {
		if (stopped) return;
		const delay = backoff[Math.min(backoffIndex, backoff.length - 1)];
		backoffIndex = Math.min(backoffIndex + 1, backoff.length - 1);
		restartTimer = setTimeout(() => {
			restartTimer = null;
			spawnChild();
		}, delay);
		restartTimer.unref?.();
	}

	function spawnChild() {
		if (stopped) return;
		const argv = [...commandBase, "event", "listen", "--resource", opts.url, "--follow", "--event", opts.eventTypes.join(",")];
		log(`spawning: ${argv.join(" ")}`);

		let sawStdoutEvent = false;
		let handledFatal = false;

		const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", env: { ...Bun.env } });
		child = proc;

		readLines(proc.stdout as ReadableStream<Uint8Array>, () => {
			if (stopped || handledFatal) return;
			sawStdoutEvent = true;
			backoffIndex = 0;
			noEventExits.length = 0;
			safeSignal("event");
		});

		readLines(proc.stderr as ReadableStream<Uint8Array>, (line) => {
			if (stopped || handledFatal) return;
			if (line.includes("not enabled for this account") || line.includes("HTTP 403")) {
				handledFatal = true;
				haltPermanently("account", line);
				return;
			}
			if (line.toLowerCase().includes("not supported") || line.includes("only available for pull requests on github.com")) {
				handledFatal = true;
				haltPermanently("pr", line);
				return;
			}
			safeSignal("attached");
		});

		proc.exited.then(() => {
			if (child === proc) child = null;
			if (stopped || handledFatal) return;

			if (!sawStdoutEvent) {
				const t = now();
				noEventExits.push(t);
				while (noEventExits.length > 0 && t - noEventExits[0] > EXIT_WINDOW_MS) noEventExits.shift();
				if (noEventExits.length >= EXIT_WINDOW_LIMIT) {
					haltPermanently("pr", "listener keeps exiting");
					return;
				}
			}
			scheduleRestart();
		});
	}

	spawnChild();

	return {
		stop() {
			if (stopped) return;
			stopped = true;
			if (restartTimer) {
				clearTimeout(restartTimer);
				restartTimer = null;
			}
			if (child) {
				try {
					child.kill();
				} catch {
					// already dead
				}
				child = null;
			}
		},
		get running() {
			return !stopped;
		},
	};
}

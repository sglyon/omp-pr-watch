// Thin I/O over an injected `Exec`. No parsing beyond JSON.parse; `snapshot.ts` interprets shapes.

import type { Exec, PrRef } from "./types";

const GH_TIMEOUT_MS = 30_000;

async function runGh(exec: Exec, args: string[]): Promise<string> {
	const res = await exec("gh", args, { timeout: GH_TIMEOUT_MS });
	if (res.code !== 0) {
		const detail = res.stderr.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
		throw new Error(`gh ${args.join(" ")} failed (code ${res.code})${detail ? `: ${detail}` : ""}`);
	}
	return res.stdout;
}

/** `gh api user --jq .login`, trimmed. */
export async function fetchSelfLogin(exec: Exec): Promise<string> {
	const out = await runGh(exec, ["api", "user", "--jq", ".login"]);
	return out.trim();
}

/**
 * Two parallel `gh` calls for one PR: the `pr view` JSON and the REST review-thread comments.
 * stderr is ignored on success (gh prints hints there); non-zero exit or unparsable JSON throws.
 */
export async function fetchPr(exec: Exec, ref: PrRef): Promise<{ view: unknown; reviewComments: unknown }> {
	const viewArgs = [
		"pr",
		"view",
		ref.url,
		"--json",
		"state,mergeable,reviewDecision,headRefOid,statusCheckRollup,reviews,comments",
	];
	const apiPath = `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/comments`;
	const apiArgs =
		ref.host === "github.com"
			? ["api", apiPath, "--paginate"]
			: ["api", apiPath, "--paginate", "--hostname", ref.host];

	const [viewOut, apiOut] = await Promise.all([runGh(exec, viewArgs), runGh(exec, apiArgs)]);

	let view: unknown;
	try {
		view = JSON.parse(viewOut);
	} catch {
		throw new Error(`gh pr view ${ref.url}: could not parse JSON output`);
	}

	let reviewComments: unknown;
	try {
		reviewComments = JSON.parse(apiOut);
	} catch {
		throw new Error(`gh api ${apiPath}: could not parse JSON output`);
	}

	return { view, reviewComments };
}

/** `gh event --help` exit code 0 means the CLI supports `gh event listen`. */
export async function eventsAvailable(exec: Exec): Promise<boolean> {
	const res = await exec("gh", ["event", "--help"], { timeout: GH_TIMEOUT_MS });
	return res.code === 0;
}

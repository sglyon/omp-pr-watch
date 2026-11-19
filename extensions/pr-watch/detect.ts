// Pure: extract created-PR URLs from tool_result-shaped events. No runtime imports.

import type { PrRef } from "./types";

const URL_PR_RE = /https?:\/\/[^\/\s]+\/[^\/\s]+\/[^\/\s]+\/pull\/\d+/g;
const URL_PR_ANCHORED_RE = /^(https?):\/\/([^\/\s]+)\/([^\/\s]+)\/([^\/\s]+)\/pull\/(\d+)/;
const SHORTHAND_RE = /^([^\/\s#]+)\/([^\/\s#]+)#(\d+)$/;

/** Parses a single PR reference: a full GitHub(-Enterprise) PR URL (optionally with a trailing
 * `/files`, `?query`, or `#fragment`) or the `owner/repo#n` shorthand (host defaults to github.com).
 * Returns `null` for anything else, including issue URLs. */
export function parsePrUrl(text: string): PrRef | null {
	const trimmed = text.trim();

	const urlMatch = trimmed.match(URL_PR_ANCHORED_RE);
	if (urlMatch) {
		const [, , host, owner, repo, numStr] = urlMatch;
		const number = Number(numStr);
		return { host, owner, repo, number, url: `https://${host}/${owner}/${repo}/pull/${number}` };
	}

	const shortMatch = trimmed.match(SHORTHAND_RE);
	if (shortMatch) {
		const [, owner, repo, numStr] = shortMatch;
		const number = Number(numStr);
		return { host: "github.com", owner, repo, number, url: `https://github.com/${owner}/${repo}/pull/${number}` };
	}

	return null;
}

/** Finds every canonical PR URL (`https://<host>/<owner>/<repo>/pull/<n>`) in free text, deduped,
 * in order of first appearance. Shorthand `owner/repo#n` references are not matched here. */
export function findPrUrls(text: string): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const match of text.matchAll(URL_PR_RE)) {
		const url = match[0];
		if (!seen.has(url)) {
			seen.add(url);
			out.push(url);
		}
	}
	return out;
}

type ToolResultEvent = {
	toolName: string;
	input: Record<string, unknown>;
	content: Array<{ type: string; text?: string }>;
	isError: boolean;
};

function textContent(content: ToolResultEvent["content"]): string {
	let out = "";
	for (const part of content) {
		if (part.type === "text" && typeof part.text === "string") {
			out += part.text;
		}
	}
	return out;
}

/** Extracts the URLs of PRs CREATED by this tool call (not viewed, listed, or otherwise
 * referenced). Returns `[]` for errored calls and for tool calls that are not a `gh pr create`
 * invocation. */
export function extractCreatedPrUrls(event: ToolResultEvent): string[] {
	if (event.isError) return [];

	const { toolName, input } = event;

	if (toolName === "bash") {
		const command = input.command;
		if (typeof command === "string" && /\bgh\s+pr\s+create\b/.test(command)) {
			return findPrUrls(textContent(event.content));
		}
		return [];
	}

	if (toolName === "github") {
		if (input.op === "pr_create") {
			return findPrUrls(textContent(event.content));
		}
		return [];
	}

	if (toolName === "write") {
		if (input.path !== "xd://github") return [];
		const rawContent = input.content;
		if (typeof rawContent !== "string") return [];
		let parsed: unknown;
		try {
			parsed = JSON.parse(rawContent);
		} catch {
			return [];
		}
		if (
			parsed !== null &&
			typeof parsed === "object" &&
			(parsed as Record<string, unknown>).op === "pr_create"
		) {
			return findPrUrls(textContent(event.content));
		}
		return [];
	}

	if (toolName === "eval") {
		const code = input.code;
		if (typeof code === "string" && code.includes("gh pr create")) {
			return findPrUrls(textContent(event.content));
		}
		return [];
	}

	return [];
}

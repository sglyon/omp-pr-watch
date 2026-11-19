import { describe, expect, test } from "bun:test";
import { extractCreatedPrUrls, findPrUrls, parsePrUrl } from "../extensions/pr-watch/detect";

describe("parsePrUrl", () => {
	test("canonicalizes a plain PR URL", () => {
		expect(parsePrUrl("https://github.com/octo-org/widgets/pull/42")).toEqual({
			host: "github.com",
			owner: "octo-org",
			repo: "widgets",
			number: 42,
			url: "https://github.com/octo-org/widgets/pull/42",
		});
	});

	test("canonicalizes a URL with a trailing /files path", () => {
		expect(parsePrUrl("https://github.com/octo-org/widgets/pull/42/files")).toEqual({
			host: "github.com",
			owner: "octo-org",
			repo: "widgets",
			number: 42,
			url: "https://github.com/octo-org/widgets/pull/42",
		});
	});

	test("canonicalizes a URL with a query string", () => {
		expect(parsePrUrl("https://github.com/octo-org/widgets/pull/42?tab=diff")).toEqual({
			host: "github.com",
			owner: "octo-org",
			repo: "widgets",
			number: 42,
			url: "https://github.com/octo-org/widgets/pull/42",
		});
	});

	test("canonicalizes a URL with a fragment", () => {
		expect(parsePrUrl("https://github.com/octo-org/widgets/pull/42#issuecomment-1")).toEqual({
			host: "github.com",
			owner: "octo-org",
			repo: "widgets",
			number: 42,
			url: "https://github.com/octo-org/widgets/pull/42",
		});
	});

	test("canonicalizes a GitHub Enterprise host URL", () => {
		expect(parsePrUrl("https://github.example.org/octo-org/widgets/pull/7")).toEqual({
			host: "github.example.org",
			owner: "octo-org",
			repo: "widgets",
			number: 7,
			url: "https://github.example.org/octo-org/widgets/pull/7",
		});
	});

	test("canonicalizes the owner/repo#n shorthand to github.com", () => {
		expect(parsePrUrl("octo-org/widgets#42")).toEqual({
			host: "github.com",
			owner: "octo-org",
			repo: "widgets",
			number: 42,
			url: "https://github.com/octo-org/widgets/pull/42",
		});
	});

	test("rejects an issues URL", () => {
		expect(parsePrUrl("https://github.com/octo-org/widgets/issues/3")).toBeNull();
	});

	test("rejects garbage input", () => {
		expect(parsePrUrl("not a pr reference at all")).toBeNull();
		expect(parsePrUrl("")).toBeNull();
		expect(parsePrUrl("octo-org/widgets")).toBeNull();
	});
});

describe("findPrUrls", () => {
	test("finds and dedupes PR URLs in free text, preserving first-appearance order", () => {
		const text = [
			"Opened https://github.com/octo-org/widgets/pull/1 and also",
			"https://github.com/octo-org/gadgets/pull/2 (see /files view at",
			"https://github.com/octo-org/gadgets/pull/2/files#discussion_r1).",
			"Duplicate: https://github.com/octo-org/widgets/pull/1?tab=diff",
		].join(" ");

		expect(findPrUrls(text)).toEqual([
			"https://github.com/octo-org/widgets/pull/1",
			"https://github.com/octo-org/gadgets/pull/2",
		]);
	});

	test("returns an empty array when there are no PR URLs", () => {
		expect(findPrUrls("no links here, just https://github.com/octo-org/widgets/issues/3")).toEqual([]);
	});
});

describe("extractCreatedPrUrls", () => {
	const okContent = (text: string) => [{ type: "text", text }];

	test("bash gh pr create", () => {
		const event = {
			toolName: "bash",
			input: { command: "gh pr create --fill" },
			content: okContent("https://github.com/octo-org/widgets/pull/9\n"),
			isError: false,
		};
		expect(extractCreatedPrUrls(event)).toEqual(["https://github.com/octo-org/widgets/pull/9"]);
	});

	test("bash gh pr create chained after cd", () => {
		const event = {
			toolName: "bash",
			input: { command: "cd widgets && gh pr create --fill --title 'Add thing'" },
			content: okContent("Creating pull request...\nhttps://github.com/octo-org/widgets/pull/11\n"),
			isError: false,
		};
		expect(extractCreatedPrUrls(event)).toEqual(["https://github.com/octo-org/widgets/pull/11"]);
	});

	test("bash gh pr view does not count as a create", () => {
		const event = {
			toolName: "bash",
			input: { command: "gh pr view https://github.com/octo-org/widgets/pull/9" },
			content: okContent("https://github.com/octo-org/widgets/pull/9\n"),
			isError: false,
		};
		expect(extractCreatedPrUrls(event)).toEqual([]);
	});

	test("bash gh pr list does not count as a create", () => {
		const event = {
			toolName: "bash",
			input: { command: "gh pr list" },
			content: okContent("https://github.com/octo-org/widgets/pull/1  Some title  branch\n"),
			isError: false,
		};
		expect(extractCreatedPrUrls(event)).toEqual([]);
	});

	test("github tool pr_create op", () => {
		const event = {
			toolName: "github",
			input: { op: "pr_create", owner: "octo-org", repo: "widgets" },
			content: okContent(JSON.stringify({ url: "https://github.com/octo-org/widgets/pull/12" })),
			isError: false,
		};
		expect(extractCreatedPrUrls(event)).toEqual(["https://github.com/octo-org/widgets/pull/12"]);
	});

	test("github tool other op does not count as a create", () => {
		const event = {
			toolName: "github",
			input: { op: "pr_view", owner: "octo-org", repo: "widgets" },
			content: okContent(JSON.stringify({ url: "https://github.com/octo-org/widgets/pull/12" })),
			isError: false,
		};
		expect(extractCreatedPrUrls(event)).toEqual([]);
	});

	test("write to xd://github with pr_create op", () => {
		const event = {
			toolName: "write",
			input: {
				path: "xd://github",
				content: JSON.stringify({ op: "pr_create", owner: "octo-org", repo: "widgets" }),
			},
			content: okContent(JSON.stringify({ url: "https://github.com/octo-org/widgets/pull/13" })),
			isError: false,
		};
		expect(extractCreatedPrUrls(event)).toEqual(["https://github.com/octo-org/widgets/pull/13"]);
	});

	test("write to xd://github with unparsable content returns empty", () => {
		const event = {
			toolName: "write",
			input: { path: "xd://github", content: "{not json" },
			content: okContent("https://github.com/octo-org/widgets/pull/14"),
			isError: false,
		};
		expect(extractCreatedPrUrls(event)).toEqual([]);
	});

	test("write to a different path is ignored", () => {
		const event = {
			toolName: "write",
			input: {
				path: "notes.md",
				content: JSON.stringify({ op: "pr_create" }),
			},
			content: okContent("https://github.com/octo-org/widgets/pull/15"),
			isError: false,
		};
		expect(extractCreatedPrUrls(event)).toEqual([]);
	});

	test("eval containing gh pr create in its code", () => {
		const event = {
			toolName: "eval",
			input: { code: "await sh('gh pr create --fill')" },
			content: okContent("https://github.com/octo-org/widgets/pull/16\n"),
			isError: false,
		};
		expect(extractCreatedPrUrls(event)).toEqual(["https://github.com/octo-org/widgets/pull/16"]);
	});

	test("eval without gh pr create in its code returns empty", () => {
		const event = {
			toolName: "eval",
			input: { code: "await sh('gh pr view https://github.com/octo-org/widgets/pull/16')" },
			content: okContent("https://github.com/octo-org/widgets/pull/16\n"),
			isError: false,
		};
		expect(extractCreatedPrUrls(event)).toEqual([]);
	});

	test("isError suppresses extraction regardless of tool", () => {
		const event = {
			toolName: "bash",
			input: { command: "gh pr create --fill" },
			content: okContent("https://github.com/octo-org/widgets/pull/9\n"),
			isError: true,
		};
		expect(extractCreatedPrUrls(event)).toEqual([]);
	});

	test("other tools are ignored", () => {
		const event = {
			toolName: "read",
			input: { path: "README.md" },
			content: okContent("https://github.com/octo-org/widgets/pull/9"),
			isError: false,
		};
		expect(extractCreatedPrUrls(event)).toEqual([]);
	});
});

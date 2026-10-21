import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { type ReviewRecord, validateReview } from "./validate-context-insights-review";

const REVIEW_PATH = path.join("spec", "001-omp-context-insights", "design-review.md");

let tempDir: string | undefined;

function writeReview(text: string): string {
	tempDir = mkdtempSync(path.join(tmpdir(), "context-review-validator-"));
	const file = path.join(tempDir, "design-review.md");
	writeFileSync(file, text);
	return file;
}

function withRecord(mutate: (record: ReviewRecord) => void): string {
	const text = readFileSync(REVIEW_PATH, "utf8");
	const match = /```json\s*\n([\s\S]*?)\n```/g.exec(text);
	if (!match) throw new Error("fixture review has no json block");
	const record = JSON.parse(match[1]!) as ReviewRecord;
	mutate(record);
	return writeReview(text.replace(match[0], `\`\`\`json\n${JSON.stringify(record, null, 2)}\n\`\`\``));
}

afterEach(() => {
	if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	tempDir = undefined;
});

describe("context insights S2-R review validator", () => {
	it("passes the real independent review", () => {
		expect(validateReview(REVIEW_PATH)).toEqual([]);
	});

	it("rejects a keyword-style fail verdict", () => {
		const file = withRecord(record => {
			record.verdict = "fail";
		});
		expect(validateReview(file)).toContain('verdict must be exactly "pass", got "fail"');
	});

	it("rejects self-review", () => {
		const file = withRecord(record => {
			record.reviewer = "main";
		});
		expect(validateReview(file)).toContain("reviewer must not be `main`");
	});

	it("rejects an open blocking finding", () => {
		const file = withRecord(record => {
			record.findings[0] = { ...record.findings[0]!, severity: "blocking", disposition: "open" };
		});
		expect(validateReview(file).some(problem => problem.includes("blocking but disposition"))).toBe(true);
	});

	it("rejects a review with too few findings", () => {
		const file = withRecord(record => {
			record.findings = record.findings.slice(0, 2);
		});
		expect(validateReview(file).some(problem => problem.includes("at least 3 findings"))).toBe(true);
	});

	it("rejects a prose-only review with no JSON record", () => {
		const file = writeReview("# Review\n\nVerdict: pass\n\nNo machine-readable record.\n");
		expect(validateReview(file)).toContain(
			"invalid review record: expected exactly one fenced json block, found 0",
		);
	});

	it("rejects multiple JSON records", () => {
		const text = readFileSync(REVIEW_PATH, "utf8");
		const file = writeReview(`${text}\n\`\`\`json\n{"reviewer":"other","verdict":"pass","findings":[]}\n\`\`\`\n`);
		expect(validateReview(file)).toContain("invalid review record: expected exactly one fenced json block, found 2");
	});

	it("rejects a missing review file", () => {
		expect(validateReview("/definitely/not/a/review.md")).toEqual([
			"missing review document: /definitely/not/a/review.md",
		]);
	});
});

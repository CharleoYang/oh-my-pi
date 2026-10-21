import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { type ReviewRecord, validateReview } from "./validate-context-insights-review";

const REVIEW_PATH = path.join("spec", "001-omp-context-insights", "design-review.md");

let temp: TempDir | undefined;

function withRecord(mutate: (record: ReviewRecord) => void): string {
	temp = TempDir.createSync("@context-review-validator-");
	const text = fs.readFileSync(REVIEW_PATH, "utf8");
	const match = /```json\s*\n([\s\S]*?)\n```/g.exec(text);
	if (!match) throw new Error("fixture review has no json block");
	const record = JSON.parse(match[1]!) as ReviewRecord;
	mutate(record);
	const replaced = text.replace(match[0], `\`\`\`json\n${JSON.stringify(record, null, 2)}\n\`\`\``);
	const file = path.join(temp.path(), "design-review.md");
	fs.writeFileSync(file, replaced);
	return file;
}

afterEach(() => {
	temp?.removeSync();
	temp = undefined;
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

	it("rejects a missing review file", () => {
		expect(validateReview("/definitely/not/a/review.md")).toEqual(["missing review document: /definitely/not/a/review.md"]);
	});
});

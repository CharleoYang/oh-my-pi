/**
 * Validator for the S2-R independent design review.
 *
 * The verdict lives in a fenced JSON block, not in prose: keyword-based checks
 * would accept `NOT APPROVED` or a FAIL buried in a nested section. The block
 * must name a reviewer other than `main`, carry one pass verdict, and leave no
 * blocking finding unfixed.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const REVIEW_PATH = path.join("spec", "001-omp-context-insights", "design-review.md");

export interface ReviewFinding {
	severity: "blocking" | "non-blocking";
	file: string;
	line: number;
	summary: string;
	disposition: "fixed" | "accepted" | "open";
}

export interface ReviewRecord {
	reviewer: string;
	reviewed_at: string;
	verdict: "pass" | "fail";
	findings: ReviewFinding[];
}

/** Extract the single fenced JSON review record. */
export function parseReview(text: string): ReviewRecord {
	const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
	if (blocks.length !== 1) throw new Error(`expected exactly one fenced json block, found ${blocks.length}`);
	const value: unknown = JSON.parse(blocks[0]![1]!);
	if (!value || typeof value !== "object") throw new Error("review record is not an object");
	return value as ReviewRecord;
}

/** Return human-readable problems; an empty array means the review is valid. */
export function validateReview(file = REVIEW_PATH): string[] {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return [`missing review document: ${file}`];
	}

	let review: ReviewRecord;
	try {
		review = parseReview(text);
	} catch (error) {
		return [`invalid review record: ${error instanceof Error ? error.message : String(error)}`];
	}

	const problems: string[] = [];
	if (typeof review.reviewer !== "string" || review.reviewer.trim().length === 0) {
		problems.push("reviewer must be a non-empty independent agent id");
	} else if (review.reviewer === "main") {
		problems.push("reviewer must not be `main`");
	}
	if (review.verdict !== "pass") problems.push(`verdict must be exactly "pass", got ${JSON.stringify(review.verdict)}`);
	if (typeof review.reviewed_at !== "string" || Number.isNaN(Date.parse(review.reviewed_at))) {
		problems.push("reviewed_at must be an ISO date string");
	}
	if (!Array.isArray(review.findings) || review.findings.length < 3) {
		problems.push(`review must record at least 3 findings, got ${Array.isArray(review.findings) ? review.findings.length : "none"}`);
	} else {
		for (const [index, finding] of review.findings.entries()) {
			const where = `findings[${index}]`;
			if (finding.severity !== "blocking" && finding.severity !== "non-blocking") {
				problems.push(`${where}.severity must be blocking|non-blocking`);
			}
			if (typeof finding.file !== "string" || finding.file.length === 0) problems.push(`${where}.file is required`);
			if (!Number.isInteger(finding.line) || finding.line < 1) problems.push(`${where}.line must be a positive integer`);
			if (typeof finding.summary !== "string" || finding.summary.length === 0) {
				problems.push(`${where}.summary is required`);
			}
			if (finding.severity === "blocking" && finding.disposition !== "fixed") {
				problems.push(`${where} is blocking but disposition is ${JSON.stringify(finding.disposition)}`);
			}
		}
	}
	return problems;
}

if (import.meta.main) {
	const file = process.argv[2] ?? REVIEW_PATH;
	const problems = validateReview(file);
	if (problems.length > 0) {
		for (const problem of problems) console.error(`FAIL: ${problem}`);
		process.exit(1);
	}
	console.log(`PASS: independent review ${file} has one machine-readable pass verdict and no open blocking findings`);
}

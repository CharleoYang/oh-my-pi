import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { validateSpec } from "./validate-context-insights-spec";

const SPEC_PATH = path.join("spec", "001-omp-context-insights", "FEATURE.md");

describe("context insights S1 intake validator", () => {
	it("passes the real intake", () => {
		const problems = validateSpec(fs.readFileSync(SPEC_PATH, "utf8"));
		expect(problems).toEqual([]);
	});

	it("fails when a required section is missing", () => {
		const text = fs.readFileSync(SPEC_PATH, "utf8").replace("## Verified baseline", "## Baseline removed");
		expect(validateSpec(text)).toContain("missing section: ## Verified baseline");
	});

	it("fails when the baseline is not evidenced", () => {
		const text = fs
			.readFileSync(SPEC_PATH, "utf8")
			.split("\n")
			.filter(line => !/^\| B\d+ \|/.test(line))
			.join("\n");
		expect(validateSpec(text).some(problem => problem.includes("at least 10 B-rows"))).toBe(true);
	});

	it("fails when a retained baseline row has no code evidence", () => {
		const lines = fs.readFileSync(SPEC_PATH, "utf8").split("\n");
		const index = lines.findIndex(line => /^\| B\d+ \|/.test(line));
		if (index === -1) throw new Error("fixture has no baseline row");
		lines[index] = lines[index]!.replaceAll("`", "");
		expect(validateSpec(lines.join("\n")).some(problem => problem.includes("no code evidence"))).toBe(true);
	});

	it("fails when acceptance criteria are missing", () => {
		const text = fs
			.readFileSync(SPEC_PATH, "utf8")
			.split("\n")
			.filter(line => !/^\| AC-\d+ \|/.test(line))
			.join("\n");
		expect(validateSpec(text).some(problem => problem.includes("at least 8 rows"))).toBe(true);
	});

	it("fails when the no-overwrite scope guard is absent", () => {
		const text = fs.readFileSync(SPEC_PATH, "utf8").replaceAll("不覆盖", "覆盖");
		expect(validateSpec(text).some(problem => problem.includes("installed omp binary"))).toBe(true);
	});

	it("fails when S2-H decisions are missing", () => {
		const text = fs.readFileSync(SPEC_PATH, "utf8").replace(/^\d+\. /gm, "");
		expect(validateSpec(text).some(problem => problem.includes("at least 3 explicit decisions"))).toBe(true);
	});
});

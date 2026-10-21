/**
 * Validator for the S1 requirement intake of
 * spec/001-omp-context-insights.
 *
 * The feature flow requires a bound validator before a step can complete.
 * This one checks the intake has the sections the downstream design and
 * acceptance gates consume — not merely that the file exists.
 *
 * Run directly (`bun scripts/ci/validate-context-insights-spec.ts`) or through
 * its test, which also proves the validator can fail on mutated input.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const SPEC_PATH = path.join("spec", "001-omp-context-insights", "FEATURE.md");

const REQUIRED_SECTIONS = [
	"## Intent",
	"## Scope",
	"## Verified baseline",
	"## Proposed acceptance criteria",
	"## Decisions requested at S2-H",
] as const;

/** Return human-readable problems; an empty array means the intake is valid. */
export function validateSpec(text: string): string[] {
	const problems: string[] = [];
	for (const section of REQUIRED_SECTIONS) {
		if (!text.includes(section)) problems.push(`missing section: ${section}`);
	}

	const baselineRows = text.split("\n").filter(line => /^\| B\d+ \|/.test(line));
	if (baselineRows.length < 10) {
		problems.push(`verified baseline needs at least 10 B-rows, found ${baselineRows.length}`);
	}
	for (const row of baselineRows) {
		if (!row.includes("`")) problems.push(`baseline row has no code evidence: ${row.slice(0, 70)}`);
	}

	const acRows = text.split("\n").filter(line => /^\| AC-\d+ \|/.test(line));
	if (acRows.length < 8) problems.push(`acceptance criteria need at least 8 rows, found ${acRows.length}`);

	if (!text.includes("不覆盖")) {
		problems.push("scope must state that the installed omp binary is not overwritten before tests pass");
	}

	const decisionsStart = text.indexOf("## Decisions requested at S2-H");
	if (decisionsStart !== -1) {
		const decisionItems = text
			.slice(decisionsStart)
			.split("\n")
			.filter(line => /^\d+\. /.test(line));
		if (decisionItems.length < 3) {
			problems.push(`S2-H needs at least 3 explicit decisions, found ${decisionItems.length}`);
		}
	}

	return problems;
}

if (import.meta.main) {
	const absolute = path.resolve(SPEC_PATH);
	const problems = validateSpec(fs.readFileSync(absolute, "utf8"));
	if (problems.length > 0) {
		for (const problem of problems) console.error(`FAIL: ${problem}`);
		process.exit(1);
	}
	console.log(`PASS: ${SPEC_PATH} has intake sections, 10+ evidenced baseline rows, 8+ acceptance rows, and explicit decisions`);
}

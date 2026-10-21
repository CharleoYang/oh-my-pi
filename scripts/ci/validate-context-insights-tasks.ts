/**
 * Validator for S4 task planning of spec-001-omp-context-insights.
 *
 * The plan is the frozen input to `loopx feature plan`: 14 columns per row,
 * seven implementation tasks, and the dependency edges the board will use.
 * The test mutates copies to prove the validator can fail.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const TASK_PATH = path.join("spec", "001-omp-context-insights", "task.md");

const EXPECTED_DEPS: Readonly<Record<string, readonly string[]>> = {
	"T-01": [],
	"T-02": ["T-01"],
	"T-03": ["T-02"],
	"T-04": ["T-01"],
	"T-05": ["T-01", "T-04"],
	"T-06": ["T-04", "T-05"],
	"T-07": ["T-03", "T-06"],
};

const HEADER = "| 任务ID | 描述 | 前置依赖 | 预计写入范围 | 状态 | 门禁进度 | 计划开始 | 计划完成 | 预计工作量 | 实际开始 | 实际完成 | ONES任务ID | ONES同步 | 产出/备注 |";

function splitRow(line: string): string[] {
	return line
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split("|")
		.map(cell => cell.trim());
}

/** Return human-readable problems; an empty array means the task plan is valid. */
export function validateTaskPlan(file = TASK_PATH): string[] {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return [`missing task plan: ${file}`];
	}
	const problems: string[] = [];
	if (!text.includes(HEADER)) problems.push("task table header must have the 14 expected columns");
	if (!text.includes("## Shared dispatch contract")) problems.push("missing Shared dispatch contract");
	if (!text.includes("TDD")) problems.push("plan must state the TDD requirement");

	const rows = text.split("\n").filter(line => /^\| T-\d{2} \|/.test(line));
	if (rows.length !== 7) problems.push(`expected 7 task rows, found ${rows.length}`);
	const seen = new Set<string>();
	for (const row of rows) {
		const cells = splitRow(row);
		if (cells.length !== 14) problems.push(`row has ${cells.length} cells, expected 14: ${cells[0]}`);
		const id = cells[0] ?? "";
		if (seen.has(id)) problems.push(`duplicate task id: ${id}`);
		seen.add(id);
		const deps = (cells[2] ?? "").trim();
		const expected = EXPECTED_DEPS[id];
		if (!expected) {
			problems.push(`unexpected task id: ${id}`);
			continue;
		}
		const actual = deps === "无" ? [] : deps.split(",").map(part => part.trim()).filter(Boolean);
		if (actual.join(",") !== expected.join(",")) {
			problems.push(`${id} dependencies are ${actual.join(",") || "none"}, expected ${expected.join(",") || "none"}`);
		}
		if (!(cells[1] ?? "").includes("[agent]")) problems.push(`${id} description must start with [agent]`);
		if (!(cells[3] ?? "")) problems.push(`${id} write scope is empty`);
		if ((cells[4] ?? "") !== "待执行") problems.push(`${id} status must be 待执行 before execution`);
		if (!(cells[13] ?? "")) problems.push(`${id} output/notes is empty`);
	}
	for (const id of Object.keys(EXPECTED_DEPS)) {
		if (!seen.has(id)) problems.push(`missing task: ${id}`);
	}
	return problems;
}

if (import.meta.main) {
	const problems = validateTaskPlan();
	if (problems.length > 0) {
		for (const problem of problems) console.error(`FAIL: ${problem}`);
		process.exit(1);
	}
	console.log("PASS: task plan has 14 columns, 7 tasks, and the expected dependency edges");
}

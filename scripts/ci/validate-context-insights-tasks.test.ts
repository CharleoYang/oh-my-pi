import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { validateTaskPlan } from "./validate-context-insights-tasks";

const TASK_PATH = path.join("spec", "001-omp-context-insights", "task.md");

let tempDir: string | undefined;

function withText(mutate: (text: string) => string): string {
	tempDir = mkdtempSync(path.join(tmpdir(), "context-task-validator-"));
	const file = path.join(tempDir, "task.md");
	writeFileSync(file, mutate(readFileSync(TASK_PATH, "utf8")));
	return file;
}

/** Remove one cell from a task row to exercise the 14-cell check. */
function dropCell(text: string, id: string, cellIndex: number): string {
	const lines = text.split("\n");
	const rowIndex = lines.findIndex(line => line.startsWith(`| ${id} |`));
	if (rowIndex === -1) throw new Error(`missing task row ${id}`);
	const cells = lines[rowIndex]!
		.slice(1, -1)
		.split("|")
		.map(cell => cell.trim());
	cells.splice(cellIndex, 1);
	lines[rowIndex] = `| ${cells.join(" | ")} |`;
	return lines.join("\n");
}

afterEach(() => {
	if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	tempDir = undefined;
});

describe("context insights S4 task validator", () => {
	it("passes the real task plan", () => {
		expect(validateTaskPlan(TASK_PATH)).toEqual([]);
	});

	it("fails when a dependency edge is wrong", () => {
		const file = withText(text =>
			text.replace(
				"| T-05 | [agent] stats 单会话 Context API（timeline/fleet/ETag） | T-01,T-04 |",
				"| T-05 | [agent] stats 单会话 Context API（timeline/fleet/ETag） | T-01 |",
			),
		);
		expect(validateTaskPlan(file)).toContain("T-05 dependencies are T-01, expected T-01,T-04");
	});

	it("fails when a task row is missing", () => {
		const file = withText(text =>
			text
				.split("\n")
				.filter(line => !line.startsWith("| T-07 |"))
				.join("\n"),
		);
		const problems = validateTaskPlan(file);
		expect(problems).toContain("expected 7 task rows, found 6");
		expect(problems).toContain("missing task: T-07");
	});

	it("fails when the status is pre-marked done", () => {
		const file = withText(text => text.replace("| 待执行 | 未开始 |", "| done | 未开始 |"));
		expect(validateTaskPlan(file).some(problem => problem.includes("status must be 待执行"))).toBe(true);
	});

	it("fails when the table header names change", () => {
		const file = withText(text => text.replace("| 任务ID | 描述 |", "| ID | 描述 |"));
		expect(validateTaskPlan(file)).toContain("task table header must have the 14 expected columns");
	});

	it("fails when a data row loses a cell", () => {
		const file = withText(text => dropCell(text, "T-01", 3));
		expect(validateTaskPlan(file)).toContain("row has 13 cells, expected 14: T-01");
	});
});

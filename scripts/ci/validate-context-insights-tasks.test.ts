import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { validateTaskPlan } from "./validate-context-insights-tasks";

const TASK_PATH = path.join("spec", "001-omp-context-insights", "task.md");

let temp: TempDir | undefined;

function withText(mutate: (text: string) => string): string {
	temp = TempDir.createSync("@context-task-validator-");
	const file = path.join(temp.path(), "task.md");
	fs.writeFileSync(file, mutate(fs.readFileSync(TASK_PATH, "utf8")));
	return file;
}

afterEach(() => {
	temp?.removeSync();
	temp = undefined;
});

describe("context insights S4 task validator", () => {
	it("passes the real task plan", () => {
		expect(validateTaskPlan(TASK_PATH)).toEqual([]);
	});

	it("fails when a dependency edge is wrong", () => {
		const file = withText(text => text.replace("| T-05 | [agent] stats 单会话 Context API（timeline/fleet/ETag） | T-01,T-04 |", "| T-05 | [agent] stats 单会话 Context API（timeline/fleet/ETag） | T-01 |"));
		expect(validateTaskPlan(file)).toContain("T-05 dependencies are T-01, expected T-01,T-04");
	});

	it("fails when a task row is missing", () => {
		const file = withText(text => text.split("\n").filter(line => !line.startsWith("| T-07 |")).join("\n"));
		const problems = validateTaskPlan(file);
		expect(problems).toContain("expected 7 task rows, found 6");
		expect(problems).toContain("missing task: T-07");
	});

	it("fails when the status is pre-marked done", () => {
		const file = withText(text => text.replace("| 待执行 | 未开始 |", "| done | 未开始 |"));
		expect(validateTaskPlan(file).some(problem => problem.includes("status must be 待执行"))).toBe(true);
	});

	it("fails when the table header is not 14 columns", () => {
		const file = withText(text => text.replace("| 任务ID | 描述 |", "| ID | 描述 |"));
		expect(validateTaskPlan(file)).toContain("task table header must have the 14 expected columns");
	});
});

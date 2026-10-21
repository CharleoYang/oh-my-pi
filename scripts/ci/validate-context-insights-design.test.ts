import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { validateDesignPackage } from "./validate-context-insights-design";

const SPEC_DIR = path.join("spec", "001-omp-context-insights");
const DOCS = [
	"FEATURE.md",
	"context-report.md",
	"[设计文档] context-insights.md",
	"[接口文档] context-insights.md",
	"[类图] context-insights.md",
];

let temp: TempDir | undefined;

function copySpec(mutate: (files: Record<string, string>) => void): string {
	temp = TempDir.createSync("@context-design-validator-");
	const files: Record<string, string> = {};
	for (const doc of DOCS) files[doc] = fs.readFileSync(path.join(SPEC_DIR, doc), "utf8");
	mutate(files);
	for (const [doc, content] of Object.entries(files)) fs.writeFileSync(path.join(temp.path(), doc), content);
	return temp.path();
}

afterEach(() => {
	temp?.removeSync();
	temp = undefined;
});

describe("context insights S2 design validator", () => {
	it("passes the real design package", () => {
		expect(validateDesignPackage(SPEC_DIR)).toEqual([]);
	});

	it("fails when a document is missing", () => {
		const dir = copySpec(files => {
			delete files["[接口文档] context-insights.md"];
		});
		expect(validateDesignPackage(dir)).toContain("missing document: [接口文档] context-insights.md");
	});

	it("fails when a design section is missing", () => {
		const dir = copySpec(files => {
			files["[设计文档] context-insights.md"] = files["[设计文档] context-insights.md"].replace("## 4. 算法", "## 4. Removed");
		});
		expect(validateDesignPackage(dir)).toContain("[设计文档] context-insights.md missing: ## 4. 算法");
	});

	it("fails when a category id is not shared", () => {
		const dir = copySpec(files => {
			files["[接口文档] context-insights.md"] = files["[接口文档] context-insights.md"].replaceAll("systemContext", "systemCtx");
		});
		expect(validateDesignPackage(dir)).toContain("[接口文档] context-insights.md missing category id: systemContext");
	});

	it("fails when the unattributed remainder is undefined", () => {
		const dir = copySpec(files => {
			files["[设计文档] context-insights.md"] = files["[设计文档] context-insights.md"].replaceAll("unattributed", "other");
			files["[接口文档] context-insights.md"] = files["[接口文档] context-insights.md"].replaceAll("unattributed", "other");
		});
		expect(validateDesignPackage(dir)).toContain("both design and interface must define the `unattributed` remainder");
	});

	it("fails when a sequence diagram is absent", () => {
		const dir = copySpec(files => {
			files["[类图] context-insights.md"] = "```mermaid\nclassDiagram\n```\n";
		});
		expect(validateDesignPackage(dir)).toContain("[类图] context-insights.md missing: sequenceDiagram");
	});
});

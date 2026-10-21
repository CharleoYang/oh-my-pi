/**
 * Validator for the S2 design package of spec/001-omp-context-insights.
 *
 * It checks the documents exist, carry the sections the implementation tasks
 * consume, and agree on the shared vocabulary (category ids, the
 * `unattributed` remainder, and the two HTTP routes). Its test mutates copies
 * to prove each check can fail.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const SPEC_DIR = path.join("spec", "001-omp-context-insights");
const REQUIRED_DOCS = [
	"FEATURE.md",
	"context-report.md",
	"[设计文档] context-insights.md",
	"[接口文档] context-insights.md",
	"[类图] context-insights.md",
] as const;

const DESIGN_SECTIONS = [
	"## 2. 架构",
	"## 3. 数据模型",
	"## 4. 算法",
	"## 5. TUI",
	"## 6. Web",
	"## 7. 降级",
	"## 8. 测试",
	"## 9. 风险",
] as const;

const INTERFACE_MARKERS = [
	"ContextTimeline",
	"ContextStep",
	"ContextEvent",
	"ContextFileActivity",
	"ContextSnapshotDetails",
	"getContextTimeline",
	"/api/context/overview",
	"/api/session/context",
	"ETag",
] as const;

const CATEGORY_IDS = ["systemPrompt", "systemTools", "systemContext", "skills", "messages"] as const;

function missingMarkers(text: string, markers: readonly string[], label: string): string[] {
	return markers.filter(marker => !text.includes(marker)).map(marker => `${label} missing: ${marker}`);
}

/** Return human-readable problems; an empty array means the design package is valid. */
export function validateDesignPackage(specDir = SPEC_DIR): string[] {
	const problems: string[] = [];
	for (const doc of REQUIRED_DOCS) {
		const file = path.join(specDir, doc);
		if (!fs.existsSync(file)) problems.push(`missing document: ${doc}`);
	}
	if (problems.length > 0) return problems;

	const design = fs.readFileSync(path.join(specDir, "[设计文档] context-insights.md"), "utf8");
	const iface = fs.readFileSync(path.join(specDir, "[接口文档] context-insights.md"), "utf8");
	const diagram = fs.readFileSync(path.join(specDir, "[类图] context-insights.md"), "utf8");
	const report = fs.readFileSync(path.join(specDir, "context-report.md"), "utf8");

	problems.push(...missingMarkers(design, DESIGN_SECTIONS, "[设计文档] context-insights.md"));
	problems.push(...missingMarkers(iface, INTERFACE_MARKERS, "[接口文档] context-insights.md"));
	problems.push(...missingMarkers(diagram, ["classDiagram", "sequenceDiagram"], "[类图] context-insights.md"));
	problems.push(...missingMarkers(report, ["## 1. 问题", "## 2. 现状", "## 3. 方案比较", "## 4. 结论"], "context-report.md"));

	for (const category of CATEGORY_IDS) {
		if (!design.includes(category)) problems.push(`[设计文档] context-insights.md missing category id: ${category}`);
		if (!iface.includes(category)) problems.push(`[接口文档] context-insights.md missing category id: ${category}`);
	}

	if (!design.includes("unattributed") || !iface.includes("unattributed")) {
		problems.push("both design and interface must define the `unattributed` remainder");
	}
	if (!design.includes("/api/session/context") || !design.includes("/api/context/overview")) {
		problems.push("[设计文档] context-insights.md must name both HTTP routes it consumes");
	}

	return problems;
}

if (import.meta.main) {
	const problems = validateDesignPackage();
	if (problems.length > 0) {
		for (const problem of problems) console.error(`FAIL: ${problem}`);
		process.exit(1);
	}
	console.log("PASS: S2 design package has all documents, required sections, shared category ids, unattributed remainder, routes, and diagrams");
}

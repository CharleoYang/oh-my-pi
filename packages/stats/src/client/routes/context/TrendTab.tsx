import { useMemo, useState } from "react";
import { Chart } from "../../charts";
import { formatCompact, formatTimestamp } from "../../data/formatters";
import { Segmented } from "../../ui";
import type { ContextTimeline } from "../../types";

const COLORS = ["#e07850", "#4e9b8a", "#7885c9", "#c49a54", "#9b6aae"];
const KEYS = ["systemPrompt", "systemTools", "systemContext", "skills", "messages"] as const;

export function TrendTab({
	timeline,
	selected,
	onSelect,
}: {
	timeline: ContextTimeline;
	selected: number;
	onSelect: (index: number) => void;
}) {
	const [delta, setDelta] = useState<"prompt" | "delta">("prompt");
	const steps = timeline.steps.slice(-200);
	const offset = timeline.steps.length - steps.length;
	const series = useMemo(() => {
		if (delta === "delta")
			return [
				{ key: "delta", label: "Δ prompt", color: COLORS[2]!, values: steps.map(step => step.deltaTokens ?? null) },
			];
		const composition = KEYS.map((key, index) => ({
			key,
			label:
				key === "systemPrompt"
					? "System prompt"
					: key === "systemTools"
						? "System tools"
						: key === "systemContext"
							? "System context"
							: key[0]!.toUpperCase() + key.slice(1),
			color: COLORS[index]!,
			values: steps.map(step => step.composition?.[key] ?? null),
		}));
		return [
			...composition,
			{
				key: "total",
				label: "Total",
				color: "#f5c56b",
				kind: "line" as const,
				values: steps.map(step => step.promptTokens),
				tooltip: false,
			},
		];
	}, [delta, steps]);
	return (
		<section className="card context-trend">
			<header className="card-header">
				<div className="card-titles">
					<h2 className="card-title">Trend</h2>
					<p className="card-description">
						Last {steps.length} steps · selected #{timeline.steps[selected]?.index ?? "-"}
					</p>
				</div>
				<Segmented
					aria-label="Trend metric"
					value={delta}
					onChange={setDelta}
					options={[
						{ value: "prompt", label: "Composition" },
						{ value: "delta", label: "Δ" },
					]}
					size="sm"
				/>
			</header>
			<div className="card-body">
				<div className="context-marker-strip">
					{steps.map(step => (
						<button
							type="button"
							key={step.id}
							className={timeline.steps[selected]?.id === step.id ? "context-marker selected" : "context-marker"}
							title={`${formatTimestamp(step.timestamp)} · ${step.deltaKind}`}
							onClick={() => onSelect(offset + steps.indexOf(step))}
						/>
					))}
				</div>
				<Chart
					slots={steps.length}
					tickLabel={index => `#${steps[index]?.index ?? ""}`}
					series={series}
					onSelect={index => onSelect(offset + index)}
					format={formatCompact}
					tooltipExtra={index => (
						<span>
							{formatTimestamp(steps[index]!.timestamp)} · step #{steps[index]!.index}
						</span>
					)}
					emptyLabel="Composition unavailable"
				/>
			</div>
		</section>
	);
}

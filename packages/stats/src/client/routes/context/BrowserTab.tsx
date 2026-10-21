import { useState } from "react";
import { formatCompact, formatTimestamp } from "../../data/formatters";
import { Card, SearchInput } from "../../ui";
import type { ContextStep, ContextTimeline } from "../../types";

export function BrowserTab({
	timeline,
	selected,
	onSelect,
}: {
	timeline: ContextTimeline;
	selected: number;
	onSelect: (index: number) => void;
}) {
	const [query, setQuery] = useState("");
	const step = timeline.steps[selected] ?? timeline.steps.at(-1);
	const details = step?.details;
	const needle = query.trim().toLowerCase();
	const tools = (details?.toolSchemas ?? []).filter(item => item.name.toLowerCase().includes(needle));
	const skills = (details?.skills ?? []).filter(item => item.name.toLowerCase().includes(needle));
	return (
		<div className="context-browser">
			<Card title="Steps">
				<div className="context-browser-steps">
					{timeline.steps.map((candidate, index) => (
						<button
							type="button"
							className={index === selected ? "context-browser-step active" : "context-browser-step"}
							key={candidate.id}
							onClick={() => onSelect(index)}
						>
							<span>#{candidate.index}</span>
							<span>{formatTimestamp(candidate.timestamp)}</span>
							<strong>{formatCompact(candidate.promptTokens)}</strong>
						</button>
					))}
				</div>
			</Card>
			<Card
				title="Context details"
				actions={<SearchInput value={query} onChange={setQuery} placeholder="Search tools or skills" width={220} />}
			>
				{!step || !details ? (
					<p className="context-notice">Details unavailable for this step.</p>
				) : (
					<div className="context-browser-details">
						<BrowserList title="Tools" items={tools} omitted={details.omittedToolSchemas} />
						<BrowserList title="Skills" items={skills} omitted={details.omittedSkills} />
						<p className="micro">
							Messages: {details.messageCount} · pending tokens: {formatCompact(details.pendingMessageTokens)} ·
							context window: {formatCompact(details.contextWindow)}
						</p>
					</div>
				)}
			</Card>
		</div>
	);
}

function BrowserList({
	title,
	items,
	omitted,
}: {
	title: string;
	items: NonNullable<ContextStep["details"]>["toolSchemas"];
	omitted?: number;
}) {
	return (
		<div className="context-browser-list">
			<h3>{title}</h3>
			{items?.map(item => (
				<div key={item.name}>
					<span className="mono">{item.name}</span>
					<span className="num">{formatCompact(item.tokens)}</span>
				</div>
			))}
			{omitted ? <span className="micro">+{omitted} omitted</span> : null}
		</div>
	);
}

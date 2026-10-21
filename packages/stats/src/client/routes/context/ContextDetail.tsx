import { ArrowLeft } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { getSessionContext } from "../../api";
import { formatCompact, formatInteger } from "../../data/formatters";
import { useQuery } from "../../data/query";
import type { ContextTimeline } from "../../types";
import { Badge, Card, PageHeader, QueryView, TableSkeleton } from "../../ui";
import { BrowserTab } from "./BrowserTab";
import { CompositionTab } from "./CompositionTab";
import { EventsTab } from "./EventsTab";
import { FilesTab } from "./FilesTab";
import { FleetTab } from "./FleetTab";
import { TrendTab } from "./TrendTab";

export type ContextTab = "composition" | "trend" | "browser" | "events" | "files" | "fleet";
const TABS: readonly ContextTab[] = ["composition", "trend", "browser", "events", "files", "fleet"];

export function ContextDetail({
	file,
	active,
	onBack,
	onOpenTrace,
}: {
	file: string;
	active: boolean;
	onBack: () => void;
	onOpenTrace: (file: string) => void;
}) {
	const [tab, setTab] = useState<ContextTab>("composition");
	const [selected, setSelected] = useState(-1);
	const [rootFile, setRootFile] = useState(file);
	const [displayFile, setDisplayFile] = useState(file);
	const query = useQuery<ContextTimeline>(
		["session-context", displayFile],
		({ signal }, previous) => getSessionContext(displayFile, signal, previous),
		{ pollMs: 15000, enabled: active },
	);
	const timeline = query.stale || (displayFile === rootFile && rootFile !== file) ? null : query.data;
	useEffect(() => {
		setSelected(-1);
		setTab("composition");
	}, [displayFile]);
	useEffect(() => {
		setRootFile(file);
		setDisplayFile(file);
	}, [file]);
	const currentStep = timeline
		? Math.min(selected < 0 ? timeline.steps.length - 1 : selected, Math.max(0, timeline.steps.length - 1))
		: 0;
	const child = displayFile !== rootFile;
	const selectAgent = (trackId: string) => {
		if (trackId === "main") return;
		setDisplayFile(trackId.startsWith("/") ? trackId : `${rootFile}/${trackId}`);
	};
	const tabs = useMemo(() => TABS.map(value => ({ value, label: value[0]!.toUpperCase() + value.slice(1) })), []);
	return (
		<div className="stack context-detail">
			<PageHeader
				title={child ? "Viewing subagent" : "Context detail"}
				description={
					<span className="mono truncate" title={displayFile}>
						{displayFile}
					</span>
				}
				actions={
					<button
						type="button"
						className="btn"
						data-variant="ghost"
						onClick={child ? () => setDisplayFile(rootFile) : onBack}
					>
						<ArrowLeft size={14} /> {child ? "Root session" : "Back"}
					</button>
				}
			/>
			{timeline && (
				<div className="context-detail-header">
					<span>
						<strong>{formatInteger(timeline.steps.length + timeline.omittedSteps)}</strong> requests
					</span>
					<span>
						<strong>{formatCompact(timeline.peakTokens)}</strong> peak prompt
					</span>
					<span>
						<strong>{timeline.events.filter(event => event.kind === "compact").length}</strong> compactions
					</span>
					{timeline.legacySteps > 0 && <Badge>legacy</Badge>}
					{timeline.truncated && <Badge tone="warn">truncated</Badge>}
					{timeline.detailsOmittedSteps > 0 && <Badge tone="warn">details omitted</Badge>}
				</div>
			)}
			{timeline && (
				<nav className="context-tabs" aria-label="Context detail tabs">
					{tabs.map(({ value, label }) => (
						<button
							type="button"
							data-testid={`context-tab-${value}`}
							className={tab === value ? "context-tab active" : "context-tab"}
							aria-selected={tab === value}
							key={value}
							onClick={() => setTab(value)}
						>
							{label}
						</button>
					))}
				</nav>
			)}
			<QueryView
				query={{ ...query, data: timeline }}
				skeleton={
					<Card title="Loading context">
						<TableSkeleton rows={5} />
					</Card>
				}
			>
				{data =>
					tab === "composition" ? (
						<CompositionTab timeline={data} selected={currentStep} onSelect={setSelected} />
					) : tab === "trend" ? (
						<TrendTab timeline={data} selected={currentStep} onSelect={setSelected} />
					) : tab === "browser" ? (
						<BrowserTab timeline={data} selected={currentStep} onSelect={setSelected} />
					) : tab === "events" ? (
						<EventsTab timeline={data} onSelect={setSelected} />
					) : tab === "files" ? (
						<FilesTab timeline={data} onOpenTrace={() => onOpenTrace(rootFile)} />
					) : (
						<FleetTab timeline={data} onOpenAgent={selectAgent} />
					)
				}
			</QueryView>
		</div>
	);
}

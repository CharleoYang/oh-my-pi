import { useMemo, useState } from "react";
import { getContextOverview } from "../api";
import { formatCompact, formatInteger, formatPercent, formatRelativeTime } from "../data/formatters";
import { useQuery } from "../data/query";
import type { ContextSessionRow, TimeRange } from "../types";
import {
	Badge,
	Card,
	type Column,
	EmptyState,
	LabelCell,
	PageHeader,
	QueryView,
	SearchInput,
	Segmented,
	Stat,
	StatGrid,
	Table,
	TableSkeleton,
} from "../ui";
import { ContextDetail } from "./context/ContextDetail";
import { ContextHeatmap } from "./context/ContextHeatmap";
import "./context/context.css";

export interface ContextRouteProps {
	active: boolean;
	range: TimeRange;
	session: string | null;
	onOpenSession: (file: string | null) => void;
}
type ContextRange = Exclude<TimeRange, "all">;
const bounded = (range: TimeRange): ContextRange => (range === "all" ? "90d" : range);

export function ContextRoute({ active, range, session, onOpenSession }: ContextRouteProps) {
	const effectiveRange = bounded(range);
	const rangeLabel = range === "all" ? "90d (all-time view is bounded)" : effectiveRange;
	if (session !== null)
		return (
			<ContextDetail
				key={session}
				file={session}
				active={active}
				onBack={() => onOpenSession(null)}
				onOpenTrace={file => {
					window.location.hash = `#/traces?range=${effectiveRange}&s=${encodeURIComponent(file)}`;
				}}
			/>
		);
	return (
		<ContextOverviewPage
			active={active}
			range={effectiveRange}
			rangeLabel={rangeLabel}
			onOpenSession={onOpenSession}
		/>
	);
}

function ContextOverviewPage({
	active,
	range,
	rangeLabel,
	onOpenSession,
}: {
	active: boolean;
	range: ContextRange;
	rangeLabel: string;
	onOpenSession: (file: string | null) => void;
}) {
	const query = useQuery(["context-overview", range], ({ signal }) => getContextOverview(range, signal), {
		pollMs: 30000,
		enabled: active,
	});
	const [metric, setMetric] = useState<"requests" | "promptTokens">("requests");
	const [filter, setFilter] = useState("");
	const filtered = useMemo(() => {
		const needle = filter.trim().toLowerCase();
		return (query.data?.sessions ?? []).filter(
			row =>
				!needle ||
				`${row.title ?? ""} ${row.file} ${row.folder} ${row.models.join(" ")}`.toLowerCase().includes(needle),
		);
	}, [filter, query.data?.sessions]);
	const columns = useMemo<Column<ContextSessionRow>[]>(
		() => [
			{
				key: "session",
				header: "Session",
				width: "34%",
				render: row => (
					<LabelCell
						primary={row.title ?? row.file.split("/").pop()}
						secondary={<span className="mono">{row.folder}</span>}
					/>
				),
				sort: row => (row.title ?? row.file).toLowerCase(),
			},
			{
				key: "models",
				header: "Models",
				render: row => (
					<span className="context-models">
						{row.models[0] ?? "-"}
						{row.models.length > 1 && <Badge>+{row.models.length - 1}</Badge>}
					</span>
				),
				sort: row => row.models[0] ?? "",
			},
			{
				key: "requests",
				header: "Requests",
				align: "right",
				render: row => <span className="num">{formatInteger(row.requests)}</span>,
				sort: row => row.requests,
			},
			{
				key: "peak",
				header: "Peak prompt",
				align: "right",
				render: row => <span className="num">{formatCompact(row.peakPromptTokens)}</span>,
				sort: row => row.peakPromptTokens,
			},
			{
				key: "avg",
				header: "Avg prompt",
				align: "right",
				render: row => <span className="num">{formatCompact(row.avgPromptTokens)}</span>,
				sort: row => row.avgPromptTokens,
			},
			{
				key: "last",
				header: "Last active",
				align: "right",
				render: row => (
					<span className="micro" title={new Date(row.endedAt).toLocaleString()}>
						{formatRelativeTime(row.endedAt)}
					</span>
				),
				sort: row => row.endedAt,
			},
		],
		[],
	);
	return (
		<div className="stack context-page">
			<PageHeader
				title="Context"
				description={`Global prompt composition · ${rangeLabel}`}
				actions={<span className="micro">DB approximation · session detail is authoritative</span>}
			/>
			<QueryView
				query={query}
				skeleton={
					<Card title="Context overview">
						<TableSkeleton rows={6} />
					</Card>
				}
				isEmpty={data => data.kpi.requests === 0}
				empty={<EmptyState title="No context activity" hint="Choose a bounded range with indexed requests." />}
			>
				{overview => (
					<>
						<StatGrid min={170}>
							{[
								["Sessions", overview.kpi.sessions],
								["Requests", overview.kpi.requests],
								["Avg prompt", overview.kpi.avgPromptTokens],
								["Peak prompt", overview.kpi.peakPromptTokens],
								["Total tokens", overview.kpi.totalTokens],
							].map(([label, value]) => (
								<div
									data-testid={`context-kpi-${String(label).toLowerCase().replaceAll(" ", "-")}`}
									key={String(label)}
								>
									<Stat
										label={label}
										value={formatCompact(Number(value))}
										hint={label === "Sessions" ? "composition lives in session detail" : undefined}
									/>
								</div>
							))}
						</StatGrid>
						<Card
							title="Activity heatmap"
							description={`Buckets follow the API response · ${rangeLabel}`}
							actions={
								<Segmented
									aria-label="Heatmap metric"
									value={metric}
									onChange={setMetric}
									options={[
										{ value: "requests", label: "Requests" },
										{ value: "promptTokens", label: "Prompt tokens" },
									]}
									size="sm"
								/>
							}
						>
							<ContextHeatmap overview={overview} metric={metric} />
						</Card>
						<Card
							title="Sessions"
							description={`${formatInteger(filtered.length)} shown · ${formatPercent(overview.kpi.requests ? (overview.kpi.requests - overview.omittedRequests) / overview.kpi.requests : 1, 0)} of requests`}
							actions={
								<SearchInput value={filter} onChange={setFilter} placeholder="Filter sessions" width={240} />
							}
							flush
							stale={query.stale}
						>
							<Table
								columns={columns}
								rows={filtered}
								rowKey={row => row.file}
								onRowClick={row => onOpenSession(row.file)}
								limit={50}
								initialSort={{ key: "last", dir: "desc" }}
								empty={<EmptyState title="No matching sessions" hint="Try a different filter." />}
							/>
						</Card>
						{(overview.omittedSessions > 0 || overview.omittedRequests > 0) && (
							<p className="context-omissions">
								+{formatInteger(overview.omittedSessions)} sessions / +{formatInteger(overview.omittedRequests)}{" "}
								requests not shown
							</p>
						)}
						<p className="micro">Composition lives in session detail; overview values are a DB approximation.</p>
					</>
				)}
			</QueryView>
		</div>
	);
}

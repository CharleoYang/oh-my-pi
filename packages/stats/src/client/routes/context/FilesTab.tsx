import { useMemo, useState } from "react";
import { formatBytes, formatCompact, formatTimestamp } from "../../data/formatters";
import { Card, type Column, SearchInput, Table } from "../../ui";
import type { ContextFileActivity, ContextTimeline } from "../../types";
import { sortFiles } from "./view-models";

export function FilesTab({
	timeline,
	onOpenTrace,
}: {
	timeline: ContextTimeline;
	onOpenTrace: (file: string) => void;
}) {
	const [filter, setFilter] = useState("");
	const files = useMemo(
		() => sortFiles(timeline.files).filter(file => file.path.toLowerCase().includes(filter.trim().toLowerCase())),
		[timeline.files, filter],
	);
	const columns = useMemo<Column<ContextFileActivity>[]>(
		() => [
			{
				key: "path",
				header: "Path",
				width: "32%",
				render: file => (
					<span className="mono truncate" title={file.path}>
						{file.path}
					</span>
				),
				sort: file => file.path,
			},
			{
				key: "reads",
				header: "R",
				align: "right",
				render: file => <span className="num">{file.reads}</span>,
				sort: file => file.reads,
			},
			{
				key: "writes",
				header: "W",
				align: "right",
				render: file => <span className="num">{file.writes}</span>,
				sort: file => file.writes,
			},
			{
				key: "edits",
				header: "E",
				align: "right",
				render: file => <span className="num">{file.edits}</span>,
				sort: file => file.edits,
			},
			{
				key: "searches",
				header: "S",
				align: "right",
				render: file => <span className="num">{file.searches}</span>,
				sort: file => file.searches,
			},
			{
				key: "lines",
				header: "Lines",
				align: "right",
				render: file => (
					<span className="num">{formatCompact(file.linesRead + file.linesAdded + file.linesRemoved)}</span>
				),
				sort: file => file.linesRead + file.linesAdded + file.linesRemoved,
			},
			{
				key: "bytes",
				header: "Bytes",
				align: "right",
				render: file => <span className="num">{formatBytes(file.bytesRead + file.bytesWritten)}</span>,
				sort: file => file.bytesRead + file.bytesWritten,
			},
			{
				key: "last",
				header: "Last",
				align: "right",
				render: file => <span className="micro">{formatTimestamp(file.lastTimestamp)}</span>,
				sort: file => file.lastTimestamp,
			},
		],
		[],
	);
	return (
		<Card
			title="Files"
			description={
				timeline.incompleteFileCalls
					? `${timeline.incompleteFileCalls} incomplete file calls · v1 opens the session trace, not a tool span`
					: "v1 opens the session trace, not a tool span"
			}
			actions={<SearchInput value={filter} onChange={setFilter} placeholder="Filter files" width={220} />}
		>
			<Table
				columns={columns}
				rows={files}
				rowKey={file => file.path}
				onRowClick={file => onOpenTrace(file.path)}
				initialSort={{ key: "last", dir: "desc" }}
				limit={50}
				empty={<p className="dim">No file activity recorded.</p>}
			/>
		</Card>
	);
}

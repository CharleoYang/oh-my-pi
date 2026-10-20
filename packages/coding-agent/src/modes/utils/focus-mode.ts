import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import {
	FocusSummaryComponent,
	type FocusActivityCounts,
	isFocusExpandable,
} from "@oh-my-pi/pi-tui/chat/focus-summary";
import type { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import type { Component } from "@oh-my-pi/pi-tui";
import { isUserTurnInitiator } from "../../session/messages";

/** Start of a user turn: the point where the per-turn activity tally resets. */
export function isFocusTurnBoundary(message: AgentMessage): boolean {
	if (message.role === "user" || message.role === "developer") return true;
	return message.role === "custom" && isUserTurnInitiator(message);
}

function countToolCalls(message: Extract<AgentMessage, { role: "assistant" }>, counts: FocusActivityCounts): void {
	for (const block of message.content) {
		if (block.type !== "toolCall") continue;
		counts.tools++;
		if (block.name === "task") counts.subagents++;
	}
}

/**
 * Apply focus mode to a fully replayed transcript: tag every assistant answer
 * that carries tool calls as interim work, and put one activity summary after
 * each turn's last answer. The summary expands the turn's folded components in
 * place when clicked. Replays rebuild components from scratch, so tags from a
 * previous pass never survive.
 */
export function applyFocusModeToTranscript(
	container: TranscriptContainer,
	components: WeakMap<AgentMessage, Component>,
	messages: readonly AgentMessage[],
	requestRender: () => void,
): void {
	let counts: FocusActivityCounts = { tools: 0, subagents: 0 };
	let anchor: AssistantMessageComponent | undefined;
	let turnStart = 0;
	const flush = (turnEnd: number) => {
		if (anchor && counts.tools > 0) {
			const anchorIndex = container.children.indexOf(anchor);
			if (anchorIndex >= 0) {
				const group = container.children.slice(turnStart, turnEnd).filter(isFocusExpandable);
				container.insertChildAt(
					new FocusSummaryComponent(counts, {
						onToggle: expanded => {
							for (const member of group) member.setFocusExpanded(expanded);
						},
						requestRender,
					}),
					anchorIndex + 1,
				);
			}
		}
		counts = { tools: 0, subagents: 0 };
		anchor = undefined;
	};
	for (const message of messages) {
		if (isFocusTurnBoundary(message)) {
			const boundary = components.get(message);
			const boundaryIndex = boundary ? container.children.indexOf(boundary) : -1;
			flush(boundaryIndex >= 0 ? boundaryIndex : container.children.length);
			turnStart = boundaryIndex >= 0 ? boundaryIndex + 1 : container.children.length;
			continue;
		}
		if (message.role !== "assistant") continue;
		const component = components.get(message);
		if (component instanceof AssistantMessageComponent) {
			component.setFocusInterim(message.content.some(block => block.type === "toolCall"));
			anchor = component;
		}
		countToolCalls(message, counts);
	}
	flush(container.children.length);
}

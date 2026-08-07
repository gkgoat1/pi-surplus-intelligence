import type { AssistantMessage } from "@earendil-works/pi-ai";

/**
 * Surplus sometimes returns an upstream failure as an otherwise ordinary
 * assistant message, for example `[Codex error: …]`. Recognize only the
 * complete, bracketed sentinel so ordinary mentions of the text stay output.
 */
export function claimedUpstreamError(message: AssistantMessage): string | undefined {
	const text = message.content
		.filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("")
		.trim();
	const match = /^\[Codex error:\s*([\s\S]*?)\]$/i.exec(text);
	return match?.[1].trim() || undefined;
}

export function upstreamClaimedErrorMessage(message: AssistantMessage, detail: string): AssistantMessage {
	return { ...message, content: [], stopReason: "error", errorMessage: `Upstream error: ${detail}` };
}
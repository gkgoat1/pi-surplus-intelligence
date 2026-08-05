import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
	Tool,
} from "@earendil-works/pi-ai";
import type { CreateAssistantMessageEventStream } from "./types.ts";

type ResponseStreamOptions = SimpleStreamOptions & {
	reasoningEffort?: string;
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	toolChoice?: unknown;
};

function usage(response: any): AssistantMessage["usage"] {
	const cached = response.usage?.input_tokens_details?.cached_tokens ?? 0;
	const cacheWrite = response.usage?.input_tokens_details?.cache_write_tokens ?? 0;
	return {
		input: Math.max(0, (response.usage?.input_tokens ?? 0) - cached - cacheWrite),
		output: response.usage?.output_tokens ?? 0,
		cacheRead: cached,
		cacheWrite,
		reasoning: response.usage?.output_tokens_details?.reasoning_tokens,
		totalTokens: response.usage?.total_tokens ?? 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function responseInput(model: Model<Api>, context: Context): any[] {
	const input: any[] = [];
	if (context.systemPrompt) {
		input.push({
			role: model.reasoning && (model.compat as any)?.supportsDeveloperRole !== false ? "developer" : "system",
			content: context.systemPrompt,
		});
	}
	for (const message of context.messages) {
		if (message.role === "user") {
			input.push({
				role: "user",
				content: typeof message.content === "string"
					? [{ type: "input_text", text: message.content }]
					: message.content.map((block) => block.type === "text"
						? { type: "input_text", text: block.text }
						: { type: "input_image", detail: "auto", image_url: `data:${block.mimeType};base64,${block.data}` }),
			});
		} else if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "text") {
					input.push({
						type: "message",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: block.text, annotations: [] }],
					});
				} else if (block.type === "toolCall") {
					const [callId, itemId] = block.id.split("|");
					input.push({ type: "function_call", id: itemId, call_id: callId, name: block.name, arguments: JSON.stringify(block.arguments) });
				}
			}
		} else {
			const [callId] = message.toolCallId.split("|");
			input.push({
				type: "function_call_output",
				call_id: callId,
				output: message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n") || "(no tool output)",
			});
		}
	}
	return input;
}

function responseTools(tools: Tool[] | undefined): any[] | undefined {
	if (!tools?.length) return undefined;
	return tools.map((tool) => ({
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		strict: false,
	}));
}

/**
 * Direct `/v1/responses` adapter for GPT-5-and-later models. Some
 * OpenAI-compatible Responses servers omit output-item events in SSE streams,
 * which causes Pi's native stream parser to lose otherwise valid tool calls.
 * Issuing a completed JSON request directly through `fetch` lets us normalize
 * headers and recover the full output array (text and function calls) from the
 * response body, then translate it into Pi's normal assistant event protocol.
 */
export function createResponsesToolStream(
	createAssistantMessageEventStream: CreateAssistantMessageEventStream,
): (model: Model<Api>, context: Context, options?: ResponseStreamOptions) => AssistantMessageEventStream {
	return (model, context, options) => {
		const stream = createAssistantMessageEventStream();
		(async () => {
			const output: AssistantMessage = {
				role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop", timestamp: Date.now(),
			};
			try {
				const headers = new Headers({ "content-type": "application/json", ...(model.headers ?? {}) });
				let hasAuth = false;
				for (const [name, value] of Object.entries(options?.headers ?? {})) {
					if (value === null) { headers.delete(name); continue; }
					headers.set(name, String(value));
					if (name.toLowerCase() === "authorization") hasAuth = true;
				}
				if (!hasAuth && options?.apiKey) headers.set("authorization", `Bearer ${options.apiKey}`);
				const payload: Record<string, any> = {
					model: model.id, input: responseInput(model, context), tools: responseTools(context.tools),
					stream: false, store: false,
				};
				// Cap this fallback request independently of the selected model's
				// advertised maximum. A Responses server may reserve and price that
				// entire maximum even when the model only needs one tool call.
				payload.max_output_tokens = Math.max(16, Math.min(options?.maxTokens ?? 4_096, 4_096));
				if (options?.temperature !== undefined) payload.temperature = options.temperature;
				if (options?.toolChoice !== undefined) payload.tool_choice = options.toolChoice;
				if (model.reasoning && (options?.reasoningEffort || options?.reasoningSummary)) {
					payload.reasoning = {
						effort: (model.thinkingLevelMap as any)?.[options.reasoningEffort ?? ""] ?? options.reasoningEffort ?? "medium",
						summary: options.reasoningSummary ?? "auto",
					};
				}
				if (options?.onPayload) {
					const replacement = await options.onPayload(payload, model);
					if (replacement !== undefined) Object.assign(payload, replacement);
				}
				const response = await fetch(`${model.baseUrl.replace(/\/$/, "")}/responses`, {
					method: "POST", headers, body: JSON.stringify(payload), signal: options?.signal,
				});
				if (!response.ok) throw new Error(`OpenAI API error: ${response.status} ${await response.text()}`);
				const body = await response.json() as any;
				output.responseId = body.id;
				output.usage = usage(body);
				output.stopReason = body.status === "incomplete" ? "length" : "stop";
				stream.push({ type: "start", partial: output });
				for (const item of body.output ?? []) {
					if (item.type === "function_call") {
						const block = { type: "toolCall" as const, id: `${item.call_id}|${item.id ?? `fc_${item.call_id}`}`, name: item.name, arguments: JSON.parse(item.arguments || "{}") };
						output.content.push(block);
						const contentIndex = output.content.length - 1;
						stream.push({ type: "toolcall_start", contentIndex, partial: output });
						stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
					} else if (item.type === "message") {
						const text = item.content?.map((part: any) => part.type === "output_text" ? part.text : part.refusal ?? "").join("") ?? "";
						const block = { type: "text" as const, text };
						output.content.push(block);
						const contentIndex = output.content.length - 1;
						stream.push({ type: "text_start", contentIndex, partial: output });
						if (text) stream.push({ type: "text_delta", contentIndex, delta: text, partial: output });
						stream.push({ type: "text_end", contentIndex, content: text, partial: output });
					}
				}
				if (output.content.some((block) => block.type === "toolCall")) output.stopReason = "toolUse";
				stream.push({ type: "done", reason: output.stopReason, message: output });
				stream.end(output);
			} catch (error) {
				output.stopReason = options?.signal?.aborted ? "aborted" : "error";
				output.errorMessage = error instanceof Error ? error.message : String(error);
				stream.push({ type: "error", reason: output.stopReason, error: output });
				stream.end(output);
			}
		})();
		return stream;
	};
}
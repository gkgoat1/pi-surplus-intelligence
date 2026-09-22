import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Message,
	Model,
	SimpleStreamOptions,
	Tool,
} from "@earendil-works/pi-ai";
import type { CreateAssistantMessageEventStream, TranscriptHelpers } from "./types.ts";

type ResponseStreamOptions = SimpleStreamOptions & {
	samplingParams?: Record<string, unknown>;
	reasoningEffort?: string;
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	toolChoice?: unknown;
};

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function upstreamMessage(body: string): string {
	try {
		const parsed = JSON.parse(body) as unknown;
		if (parsed && typeof parsed === "object") {
			const record = parsed as Record<string, unknown>;
			const nestedError = record.error;
			if (typeof record.message === "string") return record.message;
			if (nestedError && typeof nestedError === "object" && typeof (nestedError as Record<string, unknown>).message === "string") {
				return (nestedError as Record<string, unknown>).message as string;
			}
		}
	} catch {
		// Providers are not required to return JSON errors; preserve their text below.
	}
	return body;
}

function providerError(response: Response, body: string): Error {
	return new Error(`Provider returned ${response.status}: ${upstreamMessage(body)}`);
}

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

/**
 * Resolve the current system prompt and tool set across both context shapes.
 * pi-ai >= 0.86 folds them into `role: "system"` transcript entries (replayed
 * via the injected helpers); older pi-ai carries them directly on `Context`.
 */
function currentSystemPromptAndTools(
	context: Context,
	transcript: TranscriptHelpers | undefined,
): { systemPrompt: string | undefined; tools: Tool[] | undefined } {
	if (transcript) {
		return {
			systemPrompt: transcript.getCurrentSystemPrompt(context.messages) || undefined,
			tools: transcript.getCurrentTools(context.messages) as Tool[] | undefined,
		};
	}
	return { systemPrompt: context.systemPrompt, tools: context.tools };
}

function responseInput(model: Model<Api>, context: Context, systemPrompt: string | undefined): any[] {
	const input: any[] = [];
	if (systemPrompt) {
		input.push({
			role: model.reasoning && (model.compat as any)?.supportsDeveloperRole !== false ? "developer" : "system",
			content: systemPrompt,
		});
	}
	for (const raw of context.messages) {
		// pi-ai >= 0.86 carries the (already-extracted) prompt/tool state as
		// role: "system" entries mid-transcript; older pi-ai never puts a
		// system-role message in `.messages` at all, so this is a no-op there.
		// Widen for the comparison since the installed pi-ai's `Message` union
		// may predate the "system" variant (a literal-overlap type error
		// otherwise). `Exclude` is a no-op on that older union and correctly
		// drops `SystemMessage` on newer pi-ai, so the branches below keep
		// their normal control-flow narrowing either way.
		if ((raw as { role: string }).role === "system") continue;
		const message = raw as Exclude<Message, { role: "system" }>;
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
	transcript?: TranscriptHelpers,
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
				const { systemPrompt, tools } = currentSystemPromptAndTools(context, transcript);
				const payload: Record<string, any> = {
					model: model.id, input: responseInput(model, context, systemPrompt), tools: responseTools(tools),
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
				// Pi 0.84 applies model and request sampling parameters after its named
				// fields. Mirror that contract in this direct adapter so Surplus models
				// retain custom OpenAI-compatible controls such as vLLM's top_k.
				Object.assign(payload, (model as Model<Api> & { samplingParams?: Record<string, unknown> }).samplingParams ?? {}, options?.samplingParams ?? {});
				if (options?.onPayload) {
					const replacement = await options.onPayload(payload, model);
					if (replacement !== undefined) Object.assign(payload, replacement);
				}
				const response = await fetch(`${model.baseUrl.replace(/\/$/, "")}/responses`, {
					method: "POST", headers, body: JSON.stringify(payload), signal: options?.signal,
				});
				// Pi 0.84 requires custom streams to notify provider-response hooks
				// before consuming the body, including unsuccessful responses.
				await options?.onResponse?.({
					status: response.status,
					headers: Object.fromEntries(response.headers.entries()),
				}, model);
				if (!response.ok) throw providerError(response, await response.text());
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
				output.errorMessage = errorMessage(error);
				stream.push({ type: "error", reason: output.stopReason, error: output });
				stream.end(output);
			}
		})();
		return stream;
	};
}
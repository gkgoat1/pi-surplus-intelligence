import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { StreamHelpers } from "./types.ts";

export function createSurplusStreamSimple(
	helpers: StreamHelpers,
): (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream {
	const { stream: openAICompletionsStream, createAssistantMessageEventStream } = helpers;

	return function surplusStreamSimple(
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream {
		const reasoning = options?.reasoning;
		const reasoningEffort =
			reasoning && reasoning !== "off" && model.reasoning ? reasoning : undefined;

		const originalOnPayload = options?.onPayload;

		const builtInStream = openAICompletionsStream(model as Model<"openai-completions">, context, {
			...options,
			reasoningEffort,
			onPayload(payload) {
				const params = payload as Record<string, any>;
				if (model.reasoning) {
					params.include_reasoning = true;
				}
				if (
					reasoningEffort !== undefined &&
					model.compat?.supportsReasoningEffort !== false &&
					params.reasoning_effort === undefined
				) {
					params.reasoning_effort = reasoningEffort;
				}
				if (originalOnPayload) {
					const next = originalOnPayload(params, model);
					if (next !== undefined) return next;
				}
				return params;
			},
		});

		// Some Surplus models consume reasoning tokens without exposing the raw
		// reasoning text. In that case surface the token count as evidence.
		const wrapped = createAssistantMessageEventStream();
		let sawThinking = false;

		(async () => {
			try {
				for await (const event of builtInStream) {
					if (
						event.type === "thinking" ||
						event.type === "thinking_start" ||
						event.type === "thinking_delta" ||
						event.type === "thinking_end"
					) {
						if (event.type === "thinking_delta" && (event as any).delta?.length > 0) {
							sawThinking = true;
						}
						if (event.type === "thinking" && (event as any).content?.length > 0) {
							sawThinking = true;
						}
					}

					if (event.type === "done") {
						const output = (event as any).message as Record<string, any> | undefined;
						const reasoningTokens = output?.usage?.reasoning;
						if (!sawThinking && reasoningTokens) {
							const text = `Model used ${reasoningTokens} reasoning token${reasoningTokens === 1 ? "" : "s"} (no reasoning text was returned).`;
							const block = { type: "thinking", thinking: text, thinkingSignature: undefined };
							const content = output.content as any[];
							const contentIndex = content.length;
							content.push(block);
							wrapped.push({
								type: "thinking_start",
								contentIndex,
								partial: output,
							});
							wrapped.push({
								type: "thinking_delta",
								contentIndex,
								delta: text,
								partial: output,
							});
							wrapped.push({
								type: "thinking_end",
								contentIndex,
								content: text,
								partial: output,
							});
						}
						wrapped.push(event);
						wrapped.end(output);
						return;
					}

					if (event.type === "error") {
						wrapped.push(event);
						wrapped.end((event as any).error);
						return;
					}

					wrapped.push(event);
				}
				// If the loop finishes without a done/error event, close the wrapper.
				wrapped.end(undefined);
			} catch (err) {
				wrapped.push({ type: "error", reason: "error", error: err });
				wrapped.end(err);
			}
		})();

		return wrapped;
	};
}
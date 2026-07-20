import type {
	Api,
	AssistantMessage,
	AssistantMessageDiagnostic,
	Context,
	Model,
	ProviderHeaders,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
	recordPreferredRouteFailure,
	recordPreferredRouteSuccess,
	selectPreferredRoute,
	setPreferredRouteStatus,
	streamPreferredRoute,
	updatePreferredProviderStatus,
	type PreferredRoute,
} from "./preferred-providers.ts";
import type { StreamHelpers } from "./types.ts";
import { compressThinking, compressionConfig, compressionEligible } from "./thinking-compression.ts";

function optionsForUpstream(
	options: SimpleStreamOptions | undefined,
	route: PreferredRoute | undefined,
): SimpleStreamOptions {
	if (!route) return options ?? {};
	const { apiKey: _surplusApiKey, headers: _surplusHeaders, env: _surplusEnv, ...rest } = options ?? {};
	return {
		...rest,
		apiKey: route.auth.apiKey,
		headers: route.auth.headers,
		env: route.auth.env,
	};
}

export function createSurplusStreamSimple(
	helpers: StreamHelpers,
): (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream {
	const { stream: openAICompletionsStream, createAssistantMessageEventStream } = helpers;

	return function surplusStreamSimple(
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream {
		const wrapped = createAssistantMessageEventStream();

		(async () => {
			let route: PreferredRoute | undefined;
			let routeOutcomeRecorded = false;
			try {
				// The active Pi model remains Surplus. Only the upstream request is
				// substituted, avoiding global pi.setModel races with other extensions
				// and separately running agents.
				route = await selectPreferredRoute(model, options?.sessionId);
				if (route) {
					setPreferredRouteStatus(route, model);
				} else {
					updatePreferredProviderStatus(model, options?.sessionId);
				}

				const preparedOptions = optionsForUpstream(options, route);
				const { transformHeaders, ...upstreamOptions } = preparedOptions as SimpleStreamOptions & {
					transformHeaders?: (headers: ProviderHeaders) => ProviderHeaders | Promise<ProviderHeaders>;
				};
				if (transformHeaders) {
					upstreamOptions.headers = await transformHeaders(upstreamOptions.headers ?? {});
				}
				const originalOnPayload = upstreamOptions.onPayload;
				const reasoning = options?.reasoning;
				const reasoningEffort = reasoning && model.reasoning ? reasoning : undefined;

				const builtInStream = route
					? streamPreferredRoute(route, context, upstreamOptions)
					: openAICompletionsStream(model as Model<"openai-completions">, context, {
						...upstreamOptions,
						reasoningEffort,
						onPayload(payload: unknown) {
							const params = payload as Record<string, any>;
							if (model.reasoning) {
								// Prefer summarized reasoning. Closed models often expose a summary
								// instead of raw reasoning to avoid distillation and reduce token use.
								params.include_reasoning = "summary";
							}
							if (
								reasoningEffort !== undefined &&
								(model.compat as any)?.supportsReasoningEffort !== false &&
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
				let sawThinking = false;
				const sourceIdentity = route?.model ?? model;
				// A configured source is fully buffered so raw candidate thinking is
				// never emitted before compression has either succeeded or failed.
				const bufferThinking = compressionEligible(compressionConfig(options?.sessionId), sourceIdentity);
				const deferredEvents: any[] = [];
				for await (const event of builtInStream) {
					if (
						event.type === "thinking_start" ||
						event.type === "thinking_delta" ||
						event.type === "thinking_end"
					) {
						if (event.type === "thinking_delta" && (event as any).delta?.length > 0) {
							sawThinking = true;
						}
					}

					const source = event.type === "done" ? event.message : event.type === "error" ? event.error : undefined;
					if (route && source && typeof source === "object") {
						// Pi still considers Surplus selected, so preserve that logical
						// identity in history while retaining the actual upstream as
						// responseModel/diagnostics for inspection.
						const upstream = source as AssistantMessage;
						upstream.responseModel ??= upstream.model;
						upstream.model = model.id;
						upstream.provider = model.provider;
						upstream.api = model.api;
						const diagnostic: AssistantMessageDiagnostic = {
							type: "preferred_upstream",
							timestamp: Date.now(),
							details: {
								provider: route.model.provider,
								model: route.model.id,
							},
						};
						upstream.diagnostics = [...(upstream.diagnostics ?? []), diagnostic];
					}

					if (bufferThinking && event.type !== "done" && event.type !== "error") {
						deferredEvents.push(event);
						continue;
					}

					if (event.type === "done") {
						if (route) {
							recordPreferredRouteSuccess(route);
							routeOutcomeRecorded = true;
							updatePreferredProviderStatus(model, route.scopeId);
						}
						const output = event.message;
						const compressed = await compressThinking(output, sourceIdentity, context, options);
						const finalOutput = compressed?.message ?? event.message;
						const doneEvent = compressed ? { ...event, message: finalOutput } : event;
						const reasoningTokens = finalOutput.usage?.reasoning;
						if (!route && !sawThinking && reasoningTokens) {
							const text = `Model used ${reasoningTokens} reasoning token${reasoningTokens === 1 ? "" : "s"} (no reasoning text was returned).`;
							const block = { type: "thinking", thinking: text, thinkingSignature: undefined };
							const content = finalOutput.content as any[];
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
						if (bufferThinking) {
							let emittedReplacement = false;
							for (const deferred of deferredEvents) {
								const isThinking = deferred.type === "thinking_start" || deferred.type === "thinking_delta" || deferred.type === "thinking_end";
								if (!isThinking) {
									wrapped.push(deferred);
									continue;
								}
								if (!compressed) {
									wrapped.push(deferred);
									continue;
								}
								if (!emittedReplacement && deferred.type === "thinking_start") {
									const block = (finalOutput.content as any[])[compressed.index];
									wrapped.push({ type: "thinking_start", contentIndex: compressed.index, partial: finalOutput });
									wrapped.push({ type: "thinking_delta", contentIndex: compressed.index, delta: block.thinking, partial: finalOutput });
									wrapped.push({ type: "thinking_end", contentIndex: compressed.index, content: block.thinking, partial: finalOutput });
									emittedReplacement = true;
								}
							}
						} else if (compressed) {
							const block = (finalOutput.content as any[])[compressed.index];
							wrapped.push({ type: "thinking_start", contentIndex: compressed.index, partial: finalOutput });
							wrapped.push({ type: "thinking_delta", contentIndex: compressed.index, delta: block.thinking, partial: finalOutput });
							wrapped.push({ type: "thinking_end", contentIndex: compressed.index, content: block.thinking, partial: finalOutput });
						}
						wrapped.push(doneEvent);
						wrapped.end(finalOutput);
						return;
					}

					if (event.type === "error") {
						if (route && event.reason === "error") {
							recordPreferredRouteFailure(route);
							routeOutcomeRecorded = true;
							updatePreferredProviderStatus(model, route.scopeId);
						}
						const output = event.error;
						if (bufferThinking) {
							for (const deferred of deferredEvents) wrapped.push(deferred);
						}
						wrapped.push(event);
						wrapped.end(output);
						return;
					}

					wrapped.push(event);
				}
				// If the loop finishes without a done/error event, close the wrapper.
				wrapped.end(undefined);
			} catch (err) {
				if (route && !routeOutcomeRecorded && !options?.signal?.aborted) {
					recordPreferredRouteFailure(route);
					updatePreferredProviderStatus(model, route.scopeId);
				}
				const error: AssistantMessage = {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: options?.signal?.aborted ? "aborted" : "error",
					errorMessage: err instanceof Error ? err.message : String(err),
					timestamp: Date.now(),
				};
				wrapped.push({ type: "error", reason: options?.signal?.aborted ? "aborted" : "error", error });
				wrapped.end(error);
			}
		})();

		return wrapped;
	};
}
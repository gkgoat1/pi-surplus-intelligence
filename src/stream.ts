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
	minimumSavingsForModel,
	routeBaseUrl,
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
import { analyzeResponse, notifyFingerprintWarning } from "./fingerprint.ts";
import { usesOpenAIResponsesApi } from "./models.ts";
import { createResponsesToolStream } from "./responses-tools.ts";
import { claimedUpstreamError, upstreamClaimedErrorMessage } from "./upstream-error.ts";

const MAX_RESPONSE_ATTEMPTS = 15;
const INITIAL_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 60_000;

/**
 * Wait between attempts without keeping an agent alive after Pi has cancelled
 * it. Long-running workflow agents can otherwise race an aborted request's
 * retry timer and appear to hang.
 */
function waitForRetry(delayMs: number, signal: AbortSignal | undefined): Promise<boolean> {
	if (signal?.aborted) return Promise.resolve(false);
	return new Promise((resolve) => {
		const timer = setTimeout(() => finish(true), delayMs);
		const onAbort = () => finish(false);
		function finish(retry: boolean): void {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(retry);
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function abortedRequestError(): Error {
	return new Error("Request aborted");
}

function retryDelayMs(attempt: number): number {
	return Math.min(
		INITIAL_RETRY_DELAY_MS * 2 ** (attempt - 1),
		MAX_RETRY_DELAY_MS,
	);
}

function hasAssistantOutput(message: AssistantMessage): boolean {
	return message.content.some(
		(block) =>
			block.type === "toolCall" ||
			(block.type === "text" && block.text.trim().length > 0),
	);
}

function emptyAssistantResponseError(model: Model<Api>): Error {
	return new Error(`Surplus Intelligence ${model.id} returned no assistant text or tool calls`);
}

function eventStartsAssistantOutput(event: any): boolean {
	return (
		(event.type === "text_delta" && typeof event.delta === "string" && event.delta.trim().length > 0) ||
		(event.type === "text_end" && typeof event.content === "string" && event.content.trim().length > 0) ||
		event.type === "toolcall_start" ||
		event.type === "toolcall_delta" ||
		event.type === "toolcall_end"
	);
}

const CLAIMED_ERROR_PREFIX = "[codex error:";

/** Keep a possible claimed-error sentinel private until its completed message is checked. */
function extendsClaimedErrorPrefix(text: string): boolean {
	const normalized = text.trimStart().toLowerCase();
	return normalized.startsWith(CLAIMED_ERROR_PREFIX) || CLAIMED_ERROR_PREFIX.startsWith(normalized);
}

/**
 * Retry only requests whose output has not been exposed. Replaying after a
 * text or tool-call event would duplicate a partial answer in Pi's history.
 *
 * A workflow agent may spend minutes in a valid request, then lose the
 * upstream connection before producing any output. Give that case a generous
 * retry budget (15 attempts) with capped exponential backoff. Explicit Pi
 * cancellation always wins immediately; it is never retried.
 */
async function* retryFailedAssistantResponses(
	createStream: () => AssistantMessageEventStream,
	model: Model<Api>,
	signal: AbortSignal | undefined,
): AsyncGenerator<any> {
	let lastFailure: unknown;
	for (let attempt = 1; attempt <= MAX_RESPONSE_ATTEMPTS; attempt++) {
		const buffered: any[] = [];
		let forwarded = false;
		let retryableFailure = false;
		let candidateText = "";
		let bufferingClaimedError = false;
		try {
			for await (const event of createStream()) {
				if (!forwarded) {
					buffered.push(event);
					if (event.type === "text_delta" && typeof event.delta === "string") {
						candidateText += event.delta;
						bufferingClaimedError ||= extendsClaimedErrorPrefix(candidateText);
					}
					if (eventStartsAssistantOutput(event) && !bufferingClaimedError) {
						for (const bufferedEvent of buffered) yield bufferedEvent;
						forwarded = true;
					}
				} else {
					yield event;
				}

				if (event.type === "error") {
					if (forwarded || signal?.aborted || attempt === MAX_RESPONSE_ATTEMPTS) {
						if (!forwarded) for (const bufferedEvent of buffered) yield bufferedEvent;
						return;
					}
					lastFailure = event.error?.errorMessage;
					retryableFailure = true;
					break;
				}
				if (event.type !== "done") continue;
				const claimedError = claimedUpstreamError(event.message);
				if (claimedError) {
					const error = upstreamClaimedErrorMessage(event.message, claimedError);
					if (forwarded || signal?.aborted || attempt === MAX_RESPONSE_ATTEMPTS) {
						yield { type: "error", reason: "error", error };
						return;
					}
					lastFailure = error.errorMessage;
					retryableFailure = true;
					break;
				}
				if (forwarded || hasAssistantOutput(event.message)) {
					if (!forwarded) for (const bufferedEvent of buffered) yield bufferedEvent;
					return;
				}
				lastFailure = emptyAssistantResponseError(model);
				retryableFailure = true;
				break;
			}
		} catch (error) {
			lastFailure = error;
			retryableFailure = true;
		}
		if (signal?.aborted) throw abortedRequestError();
		if (!retryableFailure) lastFailure = emptyAssistantResponseError(model);
		if (attempt === MAX_RESPONSE_ATTEMPTS) {
			throw lastFailure instanceof Error ? lastFailure : new Error(String(lastFailure));
		}
		if (!(await waitForRetry(retryDelayMs(attempt), signal))) throw abortedRequestError();
	}
}

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
	const { completionsStream, responsesToolStream: responsesToolStreamHelper, createAssistantMessageEventStream } = helpers;
	const responsesDirectStream = responsesToolStreamHelper ?? createResponsesToolStream(createAssistantMessageEventStream);

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
				const minimumSavings = !route ? minimumSavingsForModel(model, options?.sessionId) : undefined;
				const upstreamModel = minimumSavings === undefined
					? model
					: { ...model, baseUrl: routeBaseUrl(model.baseUrl, minimumSavings) };
				const { transformHeaders, ...upstreamOptions } = preparedOptions as SimpleStreamOptions & {
					transformHeaders?: (headers: ProviderHeaders) => ProviderHeaders | Promise<ProviderHeaders>;
				};
				if (transformHeaders) {
					upstreamOptions.headers = await transformHeaders(upstreamOptions.headers ?? {});
				}
				const originalOnPayload = upstreamOptions.onPayload;
				const reasoning = options?.reasoning;
				const reasoningEffort = reasoning && model.reasoning ? reasoning : undefined;

				const createBuiltInStream = () =>
					route
						? streamPreferredRoute(route, context, upstreamOptions)
						: usesOpenAIResponsesApi(model.id)
							? responsesDirectStream(upstreamModel, context, {
								...upstreamOptions,
								reasoningEffort,
								reasoningSummary: model.reasoning ? "auto" : undefined,
								onPayload(payload: unknown) {
									const params = payload as Record<string, any>;
									if (originalOnPayload) {
										const next = originalOnPayload(params, model);
										if (next !== undefined) return next;
									}
									return params;
								},
							})
							: completionsStream(upstreamModel, context, {
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
				const builtInStream = retryFailedAssistantResponses(createBuiltInStream, model, options?.signal);

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
						// Attach an inline fingerprint diagnostic and warn on a strong cross-family
						// mismatch. finalOutput is the same object doneEvent references, so the
						// appended diagnostic is visible downstream without rebuilding the event.
						const fingerprint = analyzeResponse(finalOutput, model.id);
						if (fingerprint?.diagnostic) {
							finalOutput.diagnostics = [...(finalOutput.diagnostics ?? []), fingerprint.diagnostic];
							if (fingerprint.warning && fingerprint.warningKey) {
								notifyFingerprintWarning(options?.sessionId, fingerprint.warningKey, fingerprint.warning);
							}
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
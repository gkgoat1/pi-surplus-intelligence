import type {
	Api,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";

export type BuiltInStreamOptions = SimpleStreamOptions & Record<string, unknown>;

export type BuiltInStream = (
	model: Model<Api>,
	context: Context,
	options?: BuiltInStreamOptions,
) => AssistantMessageEventStream;

export type CreateAssistantMessageEventStream = () => AssistantMessageEventStream;

/**
 * pi-ai >= 0.86 normalizes provider-facing contexts into a branded
 * `TranscriptContext` that carries the system prompt and tool declarations as
 * `role: "system"` entries in `messages`, dropping the old `Context.systemPrompt`
 * / `Context.tools` fields. These helpers (from pi-ai's `utils/transcript`
 * module) replay that transcript back into a flat prompt/tool list. They are
 * absent on pi-ai < 0.86, where `Context.systemPrompt`/`Context.tools` are read
 * directly instead; see `loader.ts` and `responses-tools.ts`.
 */
export type TranscriptHelpers = {
	getCurrentSystemPrompt: (messages: readonly { role: string }[]) => string;
	getCurrentTools: (messages: readonly { role: string }[]) => any[];
};

export type StreamHelpers = {
	completionsStream: BuiltInStream;
	responsesStream: BuiltInStream;
	responsesToolStream?: BuiltInStream;
	createAssistantMessageEventStream: CreateAssistantMessageEventStream;
	/** Present only when the resolved pi-ai exports normalized-transcript helpers. */
	transcript?: TranscriptHelpers;
};
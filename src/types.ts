import type {
	Api,
	AssistantMessageEventStream,
	ClassifierContext,
	ClassifierModel,
	ClassifierApi,
	ClassifierOptions,
	ClassifierResult,
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

/**
 * pi-ai >= 1.2's transport-pluggable System One runner
 * (`dist/api/system-one-shared.js`). The extension supplies the transport
 * (URL, envelope) for the gateway's decisions rail; the runner owns the wire
 * question mapping (`bool` → `noul`), auth, retries, and answer parsing.
 */
/** A System One image asset: base64 file bytes, referenced by name from the state. */
export type SystemOneImageAsset = {
	type: "image";
	format: "png" | "jpeg";
	data_base64: string;
};

/**
 * System One request body without the transport-specific envelope. With
 * images, `state` becomes a list of asset names or image parts followed by
 * the state (pi-ai 1.4's SystemOneCompat image modes).
 */
export type SystemOneWireRequest = {
	state: unknown;
	questions: Record<string, unknown>;
	assets?: Record<string, SystemOneImageAsset>;
	images?: string[];
};

/** System One compatibility settings with every field resolved (pi-ai 1.4). */
export type ResolvedSystemOneCompat = {
	imageInput: "assets" | "images" | "state-image-urls";
	sendImageOptInHeader: boolean;
};

export type SystemOneTransport = {
	api: ClassifierApi;
	label: string;
	url(model: ClassifierModel<ClassifierApi>): URL;
	payload(model: ClassifierModel<ClassifierApi>, request: SystemOneWireRequest): Record<string, unknown>;
	output(body: unknown): Record<string, unknown>;
	/** Compatibility settings for models that do not set them in `compat` (required by pi-ai >= 1.4). */
	detectCompat(model: ClassifierModel<ClassifierApi>): ResolvedSystemOneCompat;
};

export type ClassifySystemOne = (
	transport: SystemOneTransport,
	model: ClassifierModel<ClassifierApi>,
	context: ClassifierContext,
	options: ClassifierOptions | undefined,
) => Promise<ClassifierResult>;

export type StreamHelpers = {
	completionsStream: BuiltInStream;
	responsesStream: BuiltInStream;
	responsesToolStream?: BuiltInStream;
	createAssistantMessageEventStream: CreateAssistantMessageEventStream;
	/** Present only when the resolved pi-ai exports normalized-transcript helpers. */
	transcript?: TranscriptHelpers;
	/** Present only when the resolved pi-ai (>= 1.2) ships the System One runner. */
	classifySystemOne?: ClassifySystemOne;
};
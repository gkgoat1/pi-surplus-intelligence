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

export type StreamHelpers = {
	completionsStream: BuiltInStream;
	responsesStream: BuiltInStream;
	createAssistantMessageEventStream: CreateAssistantMessageEventStream;
};
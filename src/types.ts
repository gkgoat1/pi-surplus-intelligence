import type {
	AssistantMessageEventStream,
	Context,
	Model,
} from "@earendil-works/pi-ai";

export type OpenAICompletionsStream = (
	model: Model<"openai-completions">,
	context: Context,
	options?: any,
) => AssistantMessageEventStream;

export type CreateAssistantMessageEventStream = () => AssistantMessageEventStream;

export type StreamHelpers = {
	stream: OpenAICompletionsStream;
	createAssistantMessageEventStream: CreateAssistantMessageEventStream;
};
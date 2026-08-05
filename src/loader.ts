import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { StreamHelpers } from "./types.ts";

export async function loadStreamHelpers(): Promise<StreamHelpers> {
	// The built-in API modules are ESM-only, while Pi loads extensions through
	// jiti. Resolve them relative to the running CLI and import their files.
	const binPath = realpathSync(process.argv[1] ?? process.execPath);
	const piCodingDir = dirname(fileURLToPath(pathToFileURL(binPath)));
	const aiDirCandidates = [
		join(piCodingDir, "../node_modules/@earendil-works/pi-ai"),
		join(piCodingDir, "../../pi-ai"),
		join(piCodingDir, "../lib/node_modules/@earendil-works/pi-ai"),
	];
	const aiDir = aiDirCandidates.find((candidate) =>
		existsSync(join(candidate, "dist/api/openai-completions.js")),
	);
	if (!aiDir) {
		throw new Error("Could not locate the @earendil-works/pi-ai package relative to pi-coding-agent.");
	}

	const [completionsMod, responsesMod, eventStreamMod] = await Promise.all([
		import(pathToFileURL(join(aiDir, "dist/api/openai-completions.js")).href),
		import(pathToFileURL(join(aiDir, "dist/api/openai-responses.js")).href),
		import(pathToFileURL(join(aiDir, "dist/utils/event-stream.js")).href),
	]);

	return {
		completionsStream: completionsMod.stream,
		responsesStream: responsesMod.stream,
		createAssistantMessageEventStream: eventStreamMod.createAssistantMessageEventStream,
	};
}
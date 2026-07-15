import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { StreamHelpers } from "./types.ts";

export async function loadStreamHelpers(): Promise<StreamHelpers> {
	// The built-in openai-completions module and the event-stream factory are
	// ESM-only and pi's jiti extension loader resolves subpath imports via
	// CommonJS, which fails on packages without a "require" export. Load the
	// files directly by locating pi-coding-agent's installation path from the
	// running CLI binary.
	const binPath = realpathSync(process.argv[1] ?? process.execPath);
	const piCodingDir = dirname(fileURLToPath(pathToFileURL(binPath)));
	const aiDirCandidates = [
		join(piCodingDir, "../node_modules/@earendil-works/pi-ai"),
		join(piCodingDir, "../../pi-ai"),
	];
	const aiDir = aiDirCandidates.find((candidate) =>
		existsSync(join(candidate, "dist/api/openai-completions.js")),
	);
	if (!aiDir) {
		throw new Error("Could not locate the @earendil-works/pi-ai package relative to pi-coding-agent.");
	}

	const [completionsMod, eventStreamMod] = await Promise.all([
		import(pathToFileURL(join(aiDir, "dist/api/openai-completions.js")).href),
		import(pathToFileURL(join(aiDir, "dist/utils/event-stream.js")).href),
	]);

	return {
		stream: completionsMod.stream,
		createAssistantMessageEventStream: eventStreamMod.createAssistantMessageEventStream,
	};
}
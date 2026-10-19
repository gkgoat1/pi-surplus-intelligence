import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { StreamHelpers, TranscriptHelpers } from "./types.ts";

export async function loadStreamHelpers(): Promise<StreamHelpers> {
	// The built-in API modules are ESM-only, while Pi loads extensions through
	// jiti. Resolve them relative to the running CLI and import their files.
	const binPath = realpathSync(process.argv[1] ?? process.execPath);
	const binDir = dirname(fileURLToPath(pathToFileURL(binPath)));
	// Pi 0.84.4 ships a bundled CLI (dist/bundle/cli.js) with dependencies at the
	// package root, while 0.84.1 runs dist/cli.js. Walk up from the CLI entry so
	// both layouts (and nested installs) resolve the same way.
	const aiDirCandidates: string[] = [];
	for (
		let dir = binDir;
		; dir = dirname(dir)
	) {
		aiDirCandidates.push(
			join(dir, "node_modules/@earendil-works/pi-ai"),
			join(dir, "@earendil-works/pi-ai"),
		);
		const parent = dirname(dir);
		if (parent === dir || resolve(parent) === "/") break;
	}
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
		transcript: await loadTranscriptHelpers(aiDir),
		classifySystemOne: await loadSystemOneHelper(aiDir),
	};
}

/**
 * pi-ai >= 1.2 ships `dist/api/system-one-shared.js` with the transport-
 * pluggable System One runner used for decisions/classifier models. Older
 * pi-ai has no such module; classifier registration is skipped in that case,
 * so a missing module here is expected, not an error.
 */
async function loadSystemOneHelper(aiDir: string): Promise<StreamHelpers["classifySystemOne"]> {
	try {
		const mod = await import(pathToFileURL(join(aiDir, "dist/api/system-one-shared.js")).href);
		return typeof mod.classifySystemOne === "function" ? mod.classifySystemOne : undefined;
	} catch {
		return undefined;
	}
}

/**
 * pi-ai >= 0.86 (Pi >= 0.86) ships `dist/utils/transcript.js` and normalizes
 * provider-facing contexts, dropping `Context.systemPrompt`/`Context.tools` in
 * favor of `role: "system"` transcript entries. Older pi-ai has no such module;
 * `responses-tools.ts` falls back to reading the legacy fields directly in
 * that case, so a missing module here is expected, not an error.
 */
async function loadTranscriptHelpers(aiDir: string): Promise<TranscriptHelpers | undefined> {
	try {
		const transcriptMod = await import(pathToFileURL(join(aiDir, "dist/utils/transcript.js")).href);
		if (
			typeof transcriptMod.getCurrentSystemPrompt === "function" &&
			typeof transcriptMod.getCurrentTools === "function"
		) {
			return {
				getCurrentSystemPrompt: transcriptMod.getCurrentSystemPrompt,
				getCurrentTools: transcriptMod.getCurrentTools,
			};
		}
		return undefined;
	} catch {
		return undefined;
	}
}
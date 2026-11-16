// polza: what Polza offers beyond chat, as agent tools (for threads of any
// provider) and `bb polza` commands: images, recordings, the API docs.
import type { BbPluginApi, PluginAgentToolResult, PluginCliResult } from "@get-bb/plugin-sdk";
import { experimental_resolveHostPath } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { polzaModelSlugSchema } from "./contract.js";
import { findPolzaDocsPage, polzaDocsUrl, searchPolzaDocs, type PolzaDocsStore } from "./docs.js";
import { PolzaApiError, type PolzaApiOptions } from "./http.js";
import {
  audioMimeForPath,
  formatRecordingTranscript,
  generatePolzaImage,
  imageExtension,
  POLZA_AUDIO_MAX_BYTES,
  POLZA_IMAGE_SIZES,
  transcribePolzaRecording,
} from "./media.js";

export interface PolzaToolsOptions {
  api: PolzaApiOptions;
  docs: PolzaDocsStore;
  imageModel: () => string;
  /** Plain speech-to-text model, used when speakers are not asked for. */
  voiceModel: () => string;
  diarizeModel: () => string;
}

/** Where a path given by an agent or a command lives: the host and the absolute path. */
interface Location {
  hostId?: string;
  path: string;
}

/** A tool answer the model can read whole; longer text is cut with a note saying how to get the rest. */
const TOOL_TEXT_MAX_CHARS = 20_000;
const DOCS_PAGE_CHARS = 12_000;
/** An image this small is also shown to the model; larger ones are only saved. */
const INLINE_IMAGE_MAX_BASE64 = 1_400_000;

const rub = (value: number | null): string =>
  value === null ? "" : ` Cost: ${value.toFixed(2)} RUB.`;

const failure = (error: unknown): PluginAgentToolResult => ({
  isError: true,
  content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
});

export class PolzaTools {
  constructor(
    private readonly bb: BbPluginApi,
    private readonly options: PolzaToolsOptions,
  ) {}

  /** Resolves `path` against the thread's workspace, or `cwd` when there is no thread. */
  async locate(path: string, context: { threadId?: string; cwd?: string }): Promise<Location> {
    let hostId: string | undefined;
    let root: string | null = context.cwd ?? null;
    if (context.threadId !== undefined) {
      const thread = await this.bb.sdk.threads.get({ threadId: context.threadId });
      const environmentId = thread.environmentId;
      if (environmentId !== null) {
        const environment = await this.bb.sdk.environments.get({ environmentId });
        hostId = environment.hostId;
        root = environment.path ?? root;
      }
    }
    const absolute =
      root === null
        ? /^(\/|[A-Za-z]:[\\/])/u.test(path)
          ? path
          : null
        : experimental_resolveHostPath({ rootPath: root, path });
    if (absolute === null) throw new Error(`Give an absolute path: "${path}" has no workspace to resolve against`);
    return { ...(hostId !== undefined ? { hostId } : {}), path: absolute };
  }

  async image(
    input: { prompt: string; path: string; model?: string | undefined; size?: (typeof POLZA_IMAGE_SIZES)[number] | undefined },
    context: { threadId?: string; cwd?: string; signal?: AbortSignal },
  ): Promise<{ path: string; model: string; mimeType: string; data: string; costRub: number | null }> {
    const model = input.model ?? this.options.imageModel();
    const image = await generatePolzaImage(
      this.options.api,
      { model, prompt: input.prompt, ...(input.size ? { size: input.size } : {}) },
      context.signal,
    );
    // The file gets the extension of what the model actually produced.
    const extension = imageExtension(image.mimeType);
    const wanted = /\.(png|jpe?g|webp|gif)$/iu.test(input.path)
      ? input.path.replace(/\.[a-z]+$/iu, `.${extension}`)
      : `${input.path}.${extension}`;
    const target = await this.locate(wanted, context);
    await this.bb.sdk.files.write({
      ...target,
      content: image.data,
      contentEncoding: "base64",
      createParents: true,
    });
    return { path: target.path, model, mimeType: image.mimeType, data: image.data, costRub: image.costRub };
  }

  async recording(
    input: { path: string; speakers: boolean; outputPath?: string | undefined; model?: string | undefined; responseFormat?: string | undefined },
    context: { threadId?: string; cwd?: string; signal?: AbortSignal },
  ): Promise<{ transcript: string; model: string; durationSeconds: number | null; costRub: number | null; savedTo: string | null; raw: unknown }> {
    const mimeType = audioMimeForPath(input.path);
    if (mimeType === null) {
      throw new Error("Unsupported audio format: Polza takes mp3, wav, m4a, flac, ogg and webm");
    }
    const source = await this.locate(input.path, context);
    const file = await this.bb.sdk.files.read({
      ...source,
      ...(context.signal ? { signal: context.signal } : {}),
    });
    if (file.sizeBytes > POLZA_AUDIO_MAX_BYTES) {
      throw new Error("The recording is over 50 MB; split it or lower its bitrate first");
    }
    if (!("content" in file)) throw new Error(`Could not read ${source.path}`);
    const data =
      file.contentEncoding === "base64" ? file.content : Buffer.from(file.content, "utf8").toString("base64");
    const model = input.model ?? (input.speakers ? this.options.diarizeModel() : this.options.voiceModel());
    const request = { model, data, mimeType, fileName: source.path.split(/[\\/]/u).at(-1) ?? "recording" };
    // `diarized_json` is what carries speakers with timestamps. A model that
    // does not know the format refuses the request; it is then asked plainly.
    const responseFormat = input.responseFormat ?? (input.speakers ? "diarized_json" : undefined);
    const result = await transcribePolzaRecording(
      this.options.api,
      { ...request, ...(responseFormat ? { responseFormat } : {}) },
      context.signal,
    ).catch((error: unknown) => {
      const refusedFormat =
        input.responseFormat === undefined &&
        responseFormat !== undefined &&
        error instanceof PolzaApiError &&
        (error.status === 400 || error.status === 422);
      if (!refusedFormat) throw error;
      return transcribePolzaRecording(this.options.api, request, context.signal);
    });
    const transcript = formatRecordingTranscript(result);
    let savedTo: string | null = null;
    if (input.outputPath !== undefined) {
      const target = await this.locate(input.outputPath, context);
      await this.bb.sdk.files.write({ ...target, content: `${transcript}\n`, contentEncoding: "utf8", createParents: true });
      savedTo = target.path;
    }
    return { transcript, model, durationSeconds: result.durationSeconds, costRub: result.costRub, savedTo, raw: result.raw };
  }

  /** Search results, or one page from `offset`, as text. */
  async docsText(input: { query?: string | undefined; page?: string | undefined; offset?: number | undefined }, signal?: AbortSignal): Promise<string> {
    const docs = await this.options.docs.get(signal);
    if (input.page !== undefined) {
      const page = findPolzaDocsPage(docs, input.page);
      if (page === null) throw new Error(`No docs page "${input.page}". Search first to get a path.`);
      const offset = Math.max(0, input.offset ?? 0);
      const slice = page.body.slice(offset, offset + DOCS_PAGE_CHARS);
      const rest = page.body.length - offset - slice.length;
      return [
        `# ${page.title}`,
        polzaDocsUrl(page.path),
        ...(page.description ? [page.description] : []),
        "",
        slice,
        ...(rest > 0 ? ["", `[${rest} more characters: ask for this page with offset ${offset + slice.length}]`] : []),
      ].join("\n");
    }
    const query = input.query?.trim() ?? "";
    if (query.length === 0) throw new Error("Pass a query to search or a page path to read");
    const hits = searchPolzaDocs(docs, query);
    if (hits.length === 0) return `Nothing in the Polza docs matches "${query}". Try other words, in Russian or English.`;
    return hits
      .map((hit) => [`${hit.path} — ${hit.title}`, ...(hit.description ? [hit.description] : []), `…${hit.excerpt}…`].join("\n"))
      .join("\n\n");
  }

  registerAgentTools(): void {
    const { bb } = this;
    bb.agents.registerTool({
      name: "polza_generate_image",
      description:
        "Generate an image from a text prompt with a Polza image model and save it as a file in the workspace. Use for icons, illustrations, mockups and placeholder art. Costs a few rubles per image, so generate when the user asked for an image or the task needs one.",
      parameters: z.object({
        prompt: z.string().min(1).max(8000).describe("What the image should show, in detail"),
        path: z.string().min(1).describe("Where to save it, relative to the workspace or absolute; the extension follows the produced format"),
        size: z.enum(POLZA_IMAGE_SIZES).optional().describe("Square, landscape or portrait; auto by default"),
        model: polzaModelSlugSchema.optional().describe("A Polza image model slug; omit for the configured default"),
      }),
      execute: async (params, ctx) => {
        try {
          const image = await this.image(params, { threadId: ctx.threadId, signal: ctx.signal });
          return {
            content: [
              { type: "text", text: `Saved ${image.path} (${image.mimeType}, model ${image.model}).${rub(image.costRub)}` },
              ...(image.data.length <= INLINE_IMAGE_MAX_BASE64
                ? [{ type: "image" as const, data: image.data, mimeType: image.mimeType }]
                : []),
            ],
          };
        } catch (error) {
          return failure(error);
        }
      },
    });
    bb.agents.registerTool({
      name: "polza_transcribe_recording",
      description:
        "Transcribe an audio recording of any length (a call, a meeting, an interview, a voice memo) to text with Polza, by default split into speaker turns with timestamps. Takes mp3, wav, m4a, flac, ogg and webm up to 50 MB. GigaAM-v3 is tuned for Russian; pass a Whisper model slug for other languages.",
      parameters: z.object({
        path: z.string().min(1).describe("The audio file, relative to the workspace or absolute"),
        speakers: z.boolean().optional().describe("Split the text by speaker; true by default"),
        output_path: z.string().min(1).optional().describe("Also save the full transcript to this text file"),
        model: polzaModelSlugSchema.optional().describe("A Polza speech-to-text model slug; omit for the configured default"),
      }),
      execute: async (params, ctx) => {
        try {
          const result = await this.recording(
            { path: params.path, speakers: params.speakers !== false, outputPath: params.output_path, model: params.model },
            { threadId: ctx.threadId, signal: ctx.signal },
          );
          const cut = result.transcript.length > TOOL_TEXT_MAX_CHARS;
          const header = [
            `Model ${result.model}.`,
            ...(result.durationSeconds !== null ? [`Duration ${Math.round(result.durationSeconds)} s.`] : []),
            rub(result.costRub).trim(),
            ...(result.savedTo !== null ? [`Full transcript saved to ${result.savedTo}.`] : []),
            ...(cut
              ? [
                  result.savedTo !== null
                    ? `Showing the first ${TOOL_TEXT_MAX_CHARS} of ${result.transcript.length} characters; read the file for the rest.`
                    : `Showing the first ${TOOL_TEXT_MAX_CHARS} of ${result.transcript.length} characters; call again with output_path to save it all.`,
                ]
              : []),
          ].filter((part) => part.length > 0);
          return `${header.join(" ")}\n\n${result.transcript.slice(0, TOOL_TEXT_MAX_CHARS)}`;
        } catch (error) {
          return failure(error);
        }
      },
    });
    bb.agents.registerTool({
      name: "polza_docs",
      description:
        "Look up the current Polza.ai API documentation (endpoints, parameters, models, limits, integrations). Use when writing or debugging code that calls the Polza API instead of guessing. Pass `query` to search (Russian or English), then `page` with a returned path to read a page.",
      parameters: z.object({
        query: z.string().max(300).optional().describe("Words to search the docs for"),
        page: z.string().max(300).optional().describe("A page path from the search results, to read it"),
        offset: z.number().int().min(0).optional().describe("Character offset when a page is longer than one answer"),
      }),
      execute: async (params, ctx) => {
        try {
          return await this.docsText(params, ctx.signal);
        } catch (error) {
          return failure(error);
        }
      },
    });
  }

  /** `bb polza image|transcribe|docs …`; null when the command is not one of these. */
  async runCli(
    argv: readonly string[],
    context: { threadId?: string; cwd?: string; signal?: AbortSignal },
  ): Promise<PluginCliResult | null> {
    const [command, ...rest] = argv;
    if (command !== "image" && command !== "transcribe" && command !== "docs") return null;
    const flags = new Map<string, string | true>();
    const positional: string[] = [];
    for (let at = 0; at < rest.length; at += 1) {
      const arg = rest[at]!;
      if (!arg.startsWith("--")) {
        positional.push(arg);
      } else if (arg === "--no-speakers" || arg === "--json") {
        flags.set(arg.slice(2), true);
      } else {
        const value = rest[at + 1];
        if (value === undefined) return { exitCode: 1, stderr: `${arg} needs a value` };
        flags.set(arg.slice(2), value);
        at += 1;
      }
    }
    const text = (name: string): string | undefined => {
      const value = flags.get(name);
      return typeof value === "string" ? value : undefined;
    };
    const model = text("model");
    if (model !== undefined && !polzaModelSlugSchema.safeParse(model).success) {
      return { exitCode: 1, stderr: "--model takes a <vendor>/<model> slug" };
    }
    try {
      if (command === "image") {
        const prompt = positional.join(" ").trim();
        const out = text("out");
        const size = z.enum(POLZA_IMAGE_SIZES).optional().safeParse(text("size"));
        if (prompt.length === 0 || out === undefined || !size.success) {
          return { exitCode: 1, stderr: `Usage: bb polza image <prompt> --out <path> [--size ${POLZA_IMAGE_SIZES.join("|")}] [--model <slug>]` };
        }
        const image = await this.image({ prompt, path: out, model, size: size.data }, context);
        return { exitCode: 0, stdout: `Saved ${image.path} (${image.mimeType}, model ${image.model}).${rub(image.costRub)}` };
      }
      if (command === "transcribe") {
        const path = positional[0];
        if (path === undefined) {
          return { exitCode: 1, stderr: "Usage: bb polza transcribe <audio-file> [--no-speakers] [--out <text-file>] [--model <slug>]" };
        }
        const result = await this.recording(
          { path, speakers: flags.get("no-speakers") !== true, outputPath: text("out"), model, responseFormat: text("format") },
          context,
        );
        if (flags.get("json") === true) {
          return { exitCode: 0, stdout: JSON.stringify(result.raw).slice(0, 60_000) };
        }
        const note = `Model ${result.model}.${result.durationSeconds !== null ? ` Duration ${Math.round(result.durationSeconds)} s.` : ""}${rub(result.costRub)}`;
        if (result.savedTo !== null) return { exitCode: 0, stdout: `Saved ${result.savedTo}. ${note}` };
        const shown = result.transcript.slice(0, 40_000);
        return {
          exitCode: 0,
          stdout: `${shown}${shown.length < result.transcript.length ? "\n[cut: pass --out <file> for the whole transcript]" : ""}`,
          stderr: note,
        };
      }
      const page = text("page");
      const query = positional.join(" ").trim();
      if (page === undefined && query.length === 0) {
        return { exitCode: 1, stderr: "Usage: bb polza docs <query> | bb polza docs --page <path> [--offset <n>]" };
      }
      const offset = Number.parseInt(text("offset") ?? "0", 10);
      return {
        exitCode: 0,
        stdout: await this.docsText(
          { ...(page !== undefined ? { page } : { query }), offset: Number.isFinite(offset) ? offset : 0 },
          context.signal,
        ),
      };
    } catch (error) {
      return { exitCode: 1, stderr: error instanceof Error ? error.message : String(error) };
    }
  }
}

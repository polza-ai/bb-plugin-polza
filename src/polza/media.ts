// polza: image generation and long-recording transcription for agent tools
// and the `bb polza` commands.
import { z } from "zod";
import { describePolzaError, polzaRequest, sleep, type PolzaApiOptions } from "./http.js";

export const POLZA_DEFAULT_IMAGE_MODEL = "google/gemini-3.1-flash-lite-image";
export const POLZA_DEFAULT_DIARIZE_MODEL = "ai-sage/gigaam-v3-diarize";

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

export const POLZA_IMAGE_SIZES = ["auto", "1024x1024", "1536x1024", "1024x1536"] as const;
export type PolzaImageSize = (typeof POLZA_IMAGE_SIZES)[number];

const costSchema = z
  .object({ cost_rub: z.number().nullish(), cost: z.number().nullish() })
  .passthrough()
  .nullish();

const imageDataSchema = z.object({ url: z.string().nullish(), b64_json: z.string().nullish() }).passthrough();

// A finished generation carries `data`: a list from the OpenAI-style
// endpoint, one object from the media status endpoint. A generation that is
// still running carries `id` and `status` instead.
const imageResponseSchema = z
  .object({
    id: z.string().optional(),
    requestId: z.string().optional(),
    status: z.string().optional(),
    data: z.union([z.array(imageDataSchema), imageDataSchema]).nullish(),
    usage: costSchema,
    error: z.unknown().optional(),
  })
  .passthrough();

const IMAGE_POLL_INTERVAL_MS = 3_000;
const IMAGE_MAX_WAIT_MS = 5 * 60_000;

export interface PolzaImage {
  /** Base64 of the image file. */
  data: string;
  mimeType: string;
  costRub: number | null;
}

export interface PolzaImageRequest {
  model: string;
  prompt: string;
  size?: PolzaImageSize;
  pollIntervalMs?: number;
}

/** PNG, JPEG, WebP or GIF by the file's first bytes; PNG when unknown. */
export function sniffImageMime(bytes: Uint8Array): string {
  const starts = (...signature: number[]) => signature.every((byte, at) => bytes[at] === byte);
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45) return "image/webp";
  return "image/png";
}

export function imageExtension(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/gif") return "gif";
  return "png";
}

/** Field names and value types of an unexpected answer, without its content. */
function shapeOf(value: unknown, depth = 0): string {
  if (Array.isArray(value)) return `[${value.length > 0 ? shapeOf(value[0], depth + 1) : ""}]`;
  if (value === null || typeof value !== "object") {
    return typeof value === "string" ? `string(${value.length})` : String(value === null ? null : typeof value);
  }
  if (depth > 2) return "{…}";
  return `{${Object.entries(value)
    .slice(0, 12)
    .map(([key, inner]) => `${key}: ${shapeOf(inner, depth + 1)}`)
    .join(", ")}}`;
}

export async function generatePolzaImage(
  options: PolzaApiOptions,
  request: PolzaImageRequest,
  signal?: AbortSignal,
): Promise<PolzaImage> {
  // v2 is the documented OpenAI-style endpoint; `/v1/images/generations` is a
  // legacy route that answers with a bare `requestId`.
  const body = await polzaRequest(options, "/v2/images/generations", {
    body: {
      model: request.model,
      prompt: request.prompt,
      n: 1,
      response_format: "b64_json",
      ...(request.size && request.size !== "auto" ? { size: request.size } : {}),
    },
    ...(signal ? { signal } : {}),
  });
  const read = (value: unknown): z.infer<typeof imageResponseSchema> => {
    const parsed = imageResponseSchema.safeParse(value);
    if (!parsed.success) throw new Error("Polza returned no image");
    return parsed.data;
  };
  let result = read(body);
  // A generation over two minutes turns asynchronous: the answer is then an
  // id to poll on the media endpoint instead of the image.
  const id = result.id ?? result.requestId;
  const queued = (): boolean =>
    result.data === null || result.data === undefined
      ? result.status === undefined || result.status === "pending" || result.status === "processing"
      : false;
  const deadline = Date.now() + IMAGE_MAX_WAIT_MS;
  while (id !== undefined && queued()) {
    if (Date.now() > deadline) throw new Error("The image was not ready in five minutes");
    await sleep(request.pollIntervalMs ?? IMAGE_POLL_INTERVAL_MS, signal);
    result = read(
      await polzaRequest(options, `/v1/media/${encodeURIComponent(id)}`, signal ? { signal } : {}),
    );
  }
  if (result.status === "failed" || result.status === "cancelled") {
    throw new Error(`Polza could not generate the image${describePolzaError(result)}`);
  }
  const first = Array.isArray(result.data) ? result.data[0] : result.data;
  if (first === null || first === undefined) {
    throw new Error(`Polza returned no image (answer: ${shapeOf(result)})`);
  }
  let bytes: Buffer;
  if (first.b64_json) {
    bytes = Buffer.from(first.b64_json.replace(/^data:[^,]*,/u, ""), "base64");
  } else if (first.url) {
    // Some models answer with a link whatever format was asked for.
    const response = await (options.fetchImpl ?? fetch)(first.url, signal ? { signal } : {});
    if (!response.ok) throw new Error(`The generated image could not be downloaded (HTTP ${response.status})`);
    bytes = Buffer.from(await response.arrayBuffer());
  } else {
    throw new Error(`Polza returned no image (answer: ${shapeOf(result)})`);
  }
  if (bytes.length === 0) throw new Error("Polza returned an empty image");
  return {
    data: bytes.toString("base64"),
    mimeType: sniffImageMime(bytes),
    costRub: result.usage?.cost_rub ?? result.usage?.cost ?? null,
  };
}

// ---------------------------------------------------------------------------
// Recordings
// ---------------------------------------------------------------------------

/** Polza's body limit is about 15 MB; base64 adds a third. */
export const POLZA_INLINE_AUDIO_MAX_BYTES = 10 * 1024 * 1024;
export const POLZA_AUDIO_MAX_BYTES = 50 * 1024 * 1024;
const POLL_INTERVAL_MS = 5_000;

const AUDIO_MIME_BY_EXTENSION: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  webm: "audio/webm",
};

/** The audio MIME type for a file name, or null when Polza does not take the format. */
export function audioMimeForPath(path: string): string | null {
  const extension = /\.([a-z0-9]+)$/iu.exec(path)?.[1]?.toLowerCase() ?? "";
  return AUDIO_MIME_BY_EXTENSION[extension] ?? null;
}

const segmentSchema = z
  .object({
    speaker: z.union([z.string(), z.number()]).nullish(),
    text: z.string().nullish(),
    start: z.number().nullish(),
  })
  .passthrough();

const recordingResponseSchema = z
  .object({
    id: z.string().optional(),
    status: z.string().optional(),
    text: z.string().nullish(),
    duration: z.number().nullish(),
    segments: z.array(segmentSchema).nullish(),
    usage: costSchema,
    error: z.unknown().optional(),
  })
  .passthrough();

const uploadSchema = z.object({ url: z.string().min(1) }).passthrough();

export interface PolzaRecordingSegment {
  speaker: string | null;
  text: string;
  startSeconds: number | null;
}

export interface PolzaRecordingTranscript {
  text: string;
  segments: PolzaRecordingSegment[];
  durationSeconds: number | null;
  costRub: number | null;
  /** Polza's answer as it came, for `--json`. */
  raw: unknown;
}

export interface PolzaRecordingRequest {
  model: string;
  /** Base64 of the audio file. */
  data: string;
  mimeType: string;
  fileName: string;
  /** Passed through as `response_format` when set (`diarized_json`, `verbose_json`, …). */
  responseFormat?: string;
  pollIntervalMs?: number;
}

/** Transcribes a recording of any length Polza accepts, waiting for asynchronous models. */
export async function transcribePolzaRecording(
  options: PolzaApiOptions,
  request: PolzaRecordingRequest,
  signal?: AbortSignal,
): Promise<PolzaRecordingTranscript> {
  const bytes = Buffer.from(request.data, "base64");
  if (bytes.length === 0) throw new Error("The recording is empty");
  if (bytes.length > POLZA_AUDIO_MAX_BYTES) {
    throw new Error("The recording is over 50 MB; split it or lower its bitrate first");
  }
  let file = `data:${request.mimeType};base64,${request.data}`;
  if (bytes.length > POLZA_INLINE_AUDIO_MAX_BYTES) {
    // Too large for a JSON body: park it in Polza's temporary storage and pass the link.
    const form = new FormData();
    form.set("file", new Blob([bytes], { type: request.mimeType }), request.fileName);
    form.set("storagePolicy", "TEMP_UPLOAD");
    const uploaded = uploadSchema.safeParse(
      await polzaRequest(options, "/v1/storage/upload", { body: form, ...(signal ? { signal } : {}) }),
    );
    if (!uploaded.success) throw new Error("Polza did not accept the upload");
    file = uploaded.data.url;
  }
  const read = (body: unknown): z.infer<typeof recordingResponseSchema> => {
    const parsed = recordingResponseSchema.safeParse(body);
    if (!parsed.success) throw new Error("Polza returned an unreadable transcription");
    return parsed.data;
  };
  let result = read(
    await polzaRequest(options, "/v1/audio/transcriptions", {
      body: {
        model: request.model,
        file,
        ...(request.responseFormat ? { response_format: request.responseFormat } : {}),
      },
      ...(signal ? { signal } : {}),
    }),
  );
  while (result.status === "processing" && result.id !== undefined) {
    await sleep(request.pollIntervalMs ?? POLL_INTERVAL_MS, signal);
    result = read(
      await polzaRequest(
        options,
        `/v1/audio/transcriptions/${encodeURIComponent(result.id)}`,
        signal ? { signal } : {},
      ),
    );
  }
  if (result.status === "failed") {
    const reason = typeof result.error === "string" ? `: ${result.error}` : "";
    throw new Error(`Polza could not transcribe the recording${reason}`);
  }
  const fromSegments = (result.segments ?? []).flatMap((segment): PolzaRecordingSegment[] => {
    const text = (segment.text ?? "").trim();
    if (text.length === 0) return [];
    const speaker = segment.speaker;
    return [
      {
        speaker: speaker === null || speaker === undefined ? null : speakerName(String(speaker)),
        text,
        startSeconds: segment.start ?? null,
      },
    ];
  });
  // GigaAM's diarizing model answers with the speakers marked inside the text.
  const segments = fromSegments.length > 0 ? fromSegments : splitInlineSpeakers(result.text ?? "");
  return {
    text: (result.text ?? "").trim() || segments.map((segment) => segment.text).join(" "),
    segments,
    durationSeconds: result.duration ?? null,
    costRub: result.usage?.cost_rub ?? result.usage?.cost ?? null,
    raw: result,
  };
}

/** GigaAM numbers speakers from zero (`S0`); people count from one. */
function speakerName(label: string): string {
  const index = /^S(\d+)$/u.exec(label)?.[1];
  return index === undefined ? label : `Speaker ${Number.parseInt(index, 10) + 1}`;
}

/** `[S0] Добрый день. [S1] Да.` → one segment per marked stretch; none when there are no marks. */
export function splitInlineSpeakers(text: string): PolzaRecordingSegment[] {
  const marker = /\[(?:S|SPEAKER[_ ]?)(\d+)\]/giu;
  const marks = [...text.matchAll(marker)];
  if (marks.length === 0) return [];
  return marks.flatMap((mark, at): PolzaRecordingSegment[] => {
    const from = (mark.index ?? 0) + mark[0].length;
    const part = text.slice(from, marks[at + 1]?.index ?? text.length).trim();
    if (part.length === 0) return [];
    return [{ speaker: `Speaker ${Number.parseInt(mark[1]!, 10) + 1}`, text: part, startSeconds: null }];
  });
}

function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const pad = (value: number) => String(value).padStart(2, "0");
  const hours = Math.floor(total / 3600);
  return `${hours > 0 ? `${hours}:` : ""}${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

/**
 * The transcript as readable lines. With speakers, consecutive segments of
 * one speaker merge into a turn: `[00:07] SPEAKER_01: …`. Without them it is
 * the plain text.
 */
export function formatRecordingTranscript(transcript: PolzaRecordingTranscript): string {
  if (!transcript.segments.some((segment) => segment.speaker !== null)) return transcript.text;
  const turns: { speaker: string | null; startSeconds: number | null; parts: string[] }[] = [];
  for (const segment of transcript.segments) {
    const last = turns.at(-1);
    if (last !== undefined && last.speaker === segment.speaker) {
      last.parts.push(segment.text);
    } else {
      turns.push({ speaker: segment.speaker, startSeconds: segment.startSeconds, parts: [segment.text] });
    }
  }
  return turns
    .map((turn) => {
      const time = turn.startSeconds === null ? "" : `[${clock(turn.startSeconds)}] `;
      return `${time}${turn.speaker ?? "Speaker"}: ${turn.parts.join(" ")}`;
    })
    .join("\n");
}

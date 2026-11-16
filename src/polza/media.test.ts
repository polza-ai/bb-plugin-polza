import { describe, expect, it, vi } from "vitest";
import {
  audioMimeForPath,
  formatRecordingTranscript,
  splitInlineSpeakers,
  generatePolzaImage,
  sniffImageMime,
  transcribePolzaRecording,
} from "./media.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const api = (fetchImpl: typeof fetch) => ({
  baseUrl: () => "https://polza.ai/api",
  apiKey: () => "pza_test",
  fetchImpl,
});
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]);

describe("generatePolzaImage", () => {
  it("asks for one base64 image and reports its type and cost", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      json({ created: 1, data: [{ b64_json: JPEG.toString("base64") }], usage: { cost_rub: 2.9 } }),
    );
    const image = await generatePolzaImage(api(fetchImpl), { model: "a/b", prompt: "a fox", size: "1024x1024" });
    expect(image).toEqual({ data: JPEG.toString("base64"), mimeType: "image/jpeg", costRub: 2.9 });
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://polza.ai/api/v2/images/generations");
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body))).toEqual({
      model: "a/b",
      prompt: "a fox",
      n: 1,
      response_format: "b64_json",
      size: "1024x1024",
    });
  });

  it("downloads the image when the model answers with a link", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ data: [{ url: "https://cdn.example/x.png" }] }))
      .mockResolvedValueOnce(new Response(PNG));
    const image = await generatePolzaImage(api(fetchImpl), { model: "a/b", prompt: "a fox" });
    expect(image).toEqual({ data: PNG.toString("base64"), mimeType: "image/png", costRub: null });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body))).not.toHaveProperty("size");
  });

  it("waits for a queued generation and reads the result from the media endpoint", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ id: "gen_9", status: "pending", model: "a/b" }))
      .mockResolvedValueOnce(json({ id: "gen_9", status: "processing" }))
      .mockResolvedValueOnce(json({ id: "gen_9", status: "completed", data: { url: "https://s3.polza.ai/f/x.jpg" }, usage: { cost_rub: 5 } }))
      .mockResolvedValueOnce(new Response(JPEG));
    const image = await generatePolzaImage(api(fetchImpl), { model: "a/b", prompt: "a fox", pollIntervalMs: 1 });
    expect(image).toEqual({ data: JPEG.toString("base64"), mimeType: "image/jpeg", costRub: 5 });
    expect(fetchImpl.mock.calls[1]![0]).toBe("https://polza.ai/api/v1/media/gen_9");
    const bare = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ requestId: "gen_7" }))
      .mockResolvedValueOnce(json({ id: "gen_7", status: "completed", data: { url: "https://s3.polza.ai/f/y.png" } }))
      .mockResolvedValueOnce(new Response(PNG));
    await expect(generatePolzaImage(api(bare), { model: "a/b", prompt: "a fox", pollIntervalMs: 1 })).resolves.toMatchObject({ mimeType: "image/png" });
    expect(bare.mock.calls[1]![0]).toBe("https://polza.ai/api/v1/media/gen_7");
    const failed = vi.fn<typeof fetch>().mockResolvedValue(json({ id: "gen_9", status: "failed", error: { message: "content policy" } }));
    await expect(generatePolzaImage(api(failed), { model: "a/b", prompt: "x" })).rejects.toThrow(/could not generate.*content policy/u);
  });

  it("fails clearly on a refusal and on an answer without an image", async () => {
    const refused = vi.fn<typeof fetch>().mockResolvedValue(json({ error: { message: "insufficient funds" } }, 402));
    await expect(generatePolzaImage(api(refused), { model: "a/b", prompt: "x" })).rejects.toThrow(/402.*insufficient funds/u);
    const empty = vi.fn<typeof fetch>().mockResolvedValue(json({ data: [{}] }));
    await expect(generatePolzaImage(api(empty), { model: "a/b", prompt: "x" })).rejects.toThrow(/no image/u);
  });

  it("recognizes image types by their first bytes", () => {
    expect(sniffImageMime(PNG)).toBe("image/png");
    expect(sniffImageMime(Buffer.from("RIFF0000WEBP"))).toBe("image/webp");
    expect(sniffImageMime(Buffer.from("GIF89a"))).toBe("image/gif");
  });
});

describe("transcribePolzaRecording", () => {
  const request = { model: "ai-sage/gigaam-v3-diarize", data: "AQID", mimeType: "audio/mpeg", fileName: "call.mp3", pollIntervalMs: 1 };

  it("returns speaker turns from a synchronous answer", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        text: "Добрый день. Начнём. Да.",
        duration: 15,
        usage: { cost_rub: 0.09 },
        segments: [
          { speaker: "S0", text: "Добрый день.", start: 0 },
          { speaker: "S0", text: "Начнём.", start: 3 },
          { speaker: "SPEAKER_02", text: "Да.", start: 67 },
          { speaker: "SPEAKER_02", text: " ", start: 70 },
        ],
      }),
    );
    const transcript = await transcribePolzaRecording(api(fetchImpl), request);
    expect(transcript.durationSeconds).toBe(15);
    expect(transcript.costRub).toBe(0.09);
    expect(formatRecordingTranscript(transcript)).toBe("[00:00] Speaker 1: Добрый день. Начнём.\n[01:07] SPEAKER_02: Да.");
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body))).toEqual({
      model: "ai-sage/gigaam-v3-diarize",
      file: "data:audio/mpeg;base64,AQID",
    });
  });

  it("reads speakers marked inside the text, as GigaAM's diarizing model answers", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({ text: "[S0] Добрый день. Начнём. [S1] Да, все на связи. [S0] Отлично." }));
    const transcript = await transcribePolzaRecording(api(fetchImpl), request);
    expect(formatRecordingTranscript(transcript)).toBe("Speaker 1: Добрый день. Начнём.\nSpeaker 2: Да, все на связи.\nSpeaker 1: Отлично.");
    expect(splitInlineSpeakers("без меток")).toEqual([]);
  });

  it("waits for an asynchronous model and reports a failed job", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ id: "gen_1", status: "processing" }))
      .mockResolvedValueOnce(json({ id: "gen_1", status: "completed", text: "готово" }));
    const transcript = await transcribePolzaRecording(api(fetchImpl), request);
    expect(formatRecordingTranscript(transcript)).toBe("готово");
    expect(fetchImpl.mock.calls[1]![0]).toBe("https://polza.ai/api/v1/audio/transcriptions/gen_1");
    const failed = vi.fn<typeof fetch>().mockResolvedValue(json({ id: "gen_2", status: "failed", error: "bad audio" }));
    await expect(transcribePolzaRecording(api(failed), request)).rejects.toThrow(/could not transcribe.*bad audio/u);
  });

  it("uploads a recording too large for a JSON body and passes its link", async () => {
    const big = Buffer.alloc(10 * 1024 * 1024 + 1, 1).toString("base64");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ id: "file_1", url: "https://storage.polza.ai/f/1.mp3" }))
      .mockResolvedValueOnce(json({ text: "длинная запись" }));
    await transcribePolzaRecording(api(fetchImpl), { ...request, data: big });
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://polza.ai/api/v1/storage/upload");
    expect(fetchImpl.mock.calls[0]![1]?.body).toBeInstanceOf(FormData);
    expect(JSON.parse(String(fetchImpl.mock.calls[1]![1]?.body)).file).toBe("https://storage.polza.ai/f/1.mp3");
  });

  it("refuses an empty recording and knows the audio formats Polza takes", async () => {
    await expect(transcribePolzaRecording(api(vi.fn()), { ...request, data: "" })).rejects.toThrow(/empty/u);
    expect(audioMimeForPath("/tmp/Call.M4A")).toBe("audio/mp4");
    expect(audioMimeForPath("notes.txt")).toBeNull();
  });
});

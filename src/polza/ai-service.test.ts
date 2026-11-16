import { describe, expect, it, vi } from "vitest";
import { completeWithPolza, isPlausibleCleanup, transcribeVoiceInput, transcribeWithPolza } from "./ai-service.js";

const options = (fetchImpl: typeof fetch, apiKey: string | null = "pza_test") => ({
  baseUrl: () => "https://polza.ai/api/",
  apiKey: () => apiKey,
  model: () => "anthropic/claude-haiku-5.5",
  enabled: () => true,
  voiceModel: () => "ai-sage/gigaam-v3",
  voiceEnabled: () => true,
  pollIntervalMs: 1,
  fetchImpl,
});

describe("completeWithPolza", () => {
  it("posts a chat completion with the configured model and returns the trimmed text", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "  Fix login redirect  " } }] }), { status: 200 }),
    );
    const text = await completeWithPolza("Title this", options(fetchImpl), new AbortController().signal);
    expect(text).toBe("Fix login redirect");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://polza.ai/api/v1/chat/completions");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "anthropic/claude-haiku-5.5",
      messages: [{ role: "user", content: "Title this" }],
      stream: false,
    });
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer pza_test");
  });

  it("fails clearly without a key, on an HTTP error and on an empty answer", async () => {
    const signal = new AbortController().signal;
    await expect(completeWithPolza("x", options(vi.fn(), null), signal)).rejects.toThrow(/Sign in/u);
    const refused = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "insufficient funds" } }), { status: 402 }),
    );
    await expect(completeWithPolza("x", options(refused), signal)).rejects.toThrow(/402.*insufficient funds/u);
    const empty = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), { status: 200 }),
    );
    await expect(completeWithPolza("x", options(empty), signal)).rejects.toThrow(/empty/u);
  });
});

describe("transcribeWithPolza", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const recording = () => new File([new Uint8Array([1, 2, 3])], "voice.webm", { type: "audio/webm;codecs=opus" });

  it("posts the recording as a base64 data URL to the voice model and returns the text", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({ text: " открой server.ts ", duration: 2 }));
    const text = await transcribeWithPolza(recording(), "bb, Polza", options(fetchImpl), new AbortController().signal);
    expect(text).toBe("открой server.ts");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://polza.ai/api/v1/audio/transcriptions");
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "ai-sage/gigaam-v3",
      file: "data:audio/webm;base64,AQID",
      response_format: "json",
      prompt: "bb, Polza",
    });
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer pza_test");
  });

  it("omits the prompt without a hint and accepts a recording with no words", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({ text: "" }));
    await expect(transcribeWithPolza(recording(), null, options(fetchImpl), new AbortController().signal)).resolves.toBe("");
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body))).not.toHaveProperty("prompt");
  });

  it("polls a model that answers asynchronously", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ id: "gen_1", status: "processing" }))
      .mockResolvedValueOnce(json({ id: "gen_1", status: "processing" }))
      .mockResolvedValueOnce(json({ id: "gen_1", status: "completed", text: "готово" }));
    await expect(transcribeWithPolza(recording(), null, options(fetchImpl), new AbortController().signal)).resolves.toBe("готово");
    expect(fetchImpl.mock.calls[2]![0]).toBe("https://polza.ai/api/v1/audio/transcriptions/gen_1");
  });

  it("stops polling when bb stops waiting", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
      controller.abort(new Error("timed out"));
      return json({ id: "gen_1", status: "processing" });
    });
    await expect(transcribeWithPolza(recording(), null, options(fetchImpl), controller.signal)).rejects.toThrow(/timed out/u);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fails clearly without a key, on an empty recording, an HTTP error and a failed job", async () => {
    const signal = new AbortController().signal;
    await expect(transcribeWithPolza(recording(), null, options(vi.fn(), null), signal)).rejects.toThrow(/Sign in/u);
    await expect(transcribeWithPolza(new File([], "v.webm"), null, options(vi.fn()), signal)).rejects.toThrow(/empty/u);
    const refused = vi.fn<typeof fetch>().mockResolvedValue(json({ error: { message: "insufficient funds" } }, 402));
    await expect(transcribeWithPolza(recording(), null, options(refused), signal)).rejects.toThrow(/402.*insufficient funds/u);
    const failed = vi.fn<typeof fetch>().mockResolvedValue(json({ id: "gen_1", status: "failed", error: "bad audio" }));
    await expect(transcribeWithPolza(recording(), null, options(failed), signal)).rejects.toThrow(/could not transcribe.*bad audio/u);
  });
});

describe("transcribeVoiceInput", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const recording = () => new File([new Uint8Array([1, 2, 3])], "voice.webm", { type: "audio/webm" });
  const raw = "Открой файл-сервер ТС и добавь настройку модели.";
  const withCleanup = (fetchImpl: typeof fetch, now?: () => number) => ({
    ...options(fetchImpl),
    voiceCleanup: () => true,
    ...(now ? { now } : {}),
  });
  const pipeline = (cleanup: () => Response | Promise<Response>) =>
    vi.fn<typeof fetch>().mockImplementation(async (url) =>
      String(url).endsWith("/audio/transcriptions") ? json({ text: raw }) : cleanup(),
    );
  const signal = () => new AbortController().signal;

  it("returns the corrected text and sends the vocabulary to the correction model", async () => {
    const fetchImpl = pipeline(() => json({ choices: [{ message: { content: "Открой файл server.ts и добавь настройку модели." } }] }));
    await expect(transcribeVoiceInput(recording(), "server.ts", withCleanup(fetchImpl), signal())).resolves.toBe(
      "Открой файл server.ts и добавь настройку модели.",
    );
    const body = JSON.parse(String(fetchImpl.mock.calls[1]![1]?.body));
    expect(body.temperature).toBe(0);
    expect(body.messages[0].content).toContain(raw);
    expect(body.messages[0].content).toContain("server.ts");
  });

  it("keeps the recognized text when the correction fails, answers instead of correcting, or has no time left", async () => {
    const failing = pipeline(() => json({ error: { message: "overloaded" } }, 503));
    await expect(transcribeVoiceInput(recording(), null, withCleanup(failing), signal())).resolves.toBe(raw);
    const chatty = pipeline(() => json({ choices: [{ message: { content: "Готово." } }] }));
    await expect(transcribeVoiceInput(recording(), null, withCleanup(chatty), signal())).resolves.toBe(raw);
    const clock = [0, 8_000];
    const slow = pipeline(() => json({ choices: [{ message: { content: raw } }] }));
    await expect(transcribeVoiceInput(recording(), null, withCleanup(slow, () => clock.shift() ?? 8_000), signal())).resolves.toBe(raw);
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it("does not call the correction model when it is turned off or nothing was said", async () => {
    const off = pipeline(() => json({}));
    await expect(transcribeVoiceInput(recording(), null, options(off), signal())).resolves.toBe(raw);
    expect(off).toHaveBeenCalledTimes(1);
    const silent = vi.fn<typeof fetch>().mockResolvedValue(json({ text: "" }));
    await expect(transcribeVoiceInput(recording(), null, withCleanup(silent), signal())).resolves.toBe("");
    expect(silent).toHaveBeenCalledTimes(1);
  });

  it("rejects answers that are not the same utterance", () => {
    expect(isPlausibleCleanup("привет мир", "Привет, мир.")).toBe(true);
    expect(isPlausibleCleanup("длинная фраза про настройку сервера и модели", "ок")).toBe(false);
    expect(isPlausibleCleanup("привет", "<transcript>привет</transcript>")).toBe(false);
  });
});

import { describe, expect, it, vi } from "vitest";
import { completeWithPolza } from "./ai-service.js";

const options = (fetchImpl: typeof fetch, apiKey: string | null = "pza_test") => ({
  baseUrl: () => "https://polza.ai/api/",
  apiKey: () => apiKey,
  model: () => "anthropic/claude-haiku-5.5",
  enabled: () => true,
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

import { describe, expect, it, vi } from "vitest";
import { SIGNED_OUT_ACCOUNT, type PolzaAccount } from "./account.js";
import { PolzaBalanceWatch } from "./balance-watch.js";
import { findPolzaDocsPage, parseDocsPage, PolzaDocsStore, searchPolzaDocs } from "./docs.js";
import { applyReplacements, findRetiredModels, PolzaReplacements } from "./replacements.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const api = (fetchImpl: typeof fetch) => ({
  baseUrl: () => "https://polza.ai/api",
  apiKey: () => null,
  fetchImpl,
});

describe("retired models", () => {
  const replacements = new Map([
    ["anthropic/claude-opus-4", "anthropic/claude-opus-5.5"],
    ["openai/gpt-5-codex", "/collections/text"],
  ]);

  it("flags retired picker models with a successor or a catalog page", () => {
    const retired = findRetiredModels(["openai/gpt-5.4", "anthropic/claude-opus-4", "openai/gpt-5-codex"], replacements);
    expect(retired).toEqual([
      { id: "anthropic/claude-opus-4", replacedBy: "anthropic/claude-opus-5.5", url: null },
      { id: "openai/gpt-5-codex", replacedBy: null, url: "https://polza.ai/collections/text" },
    ]);
  });

  it("swaps a retired model for its successor in place and keeps the rest", () => {
    const selected = ["anthropic/claude-opus-4", "anthropic/claude-opus-5.5", "openai/gpt-5-codex"];
    expect(applyReplacements(selected, findRetiredModels(selected, replacements))).toEqual([
      "anthropic/claude-opus-5.5",
      "openai/gpt-5-codex",
    ]);
  });

  it("loads the public list without a key and serves the last answer when a refresh fails", async () => {
    let clock = 0;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ data: [{ id: "a/old", replaced_by: "a/new" }] }))
      .mockResolvedValueOnce(json({}, 503));
    const store = new PolzaReplacements(api(fetchImpl), () => clock);
    expect((await store.get()).get("a/old")).toBe("a/new");
    expect((fetchImpl.mock.calls[0]![1]?.headers as Record<string, string>)["authorization"]).toBeUndefined();
    await store.get();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    clock = 2 * 60 * 60_000;
    expect((await store.get()).get("a/old")).toBe("a/new");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("Polza docs", () => {
  const docs = {
    release: 2,
    pages: [
      parseDocsPage(
        "api-reference/audio/transcriptions",
        "---\ntitle: POST Audio Transcriptions\ndescription: Транскрибация аудио в текст\n---\n\nЭндпоинт принимает аудио в base64 и возвращает text.",
      ),
      parseDocsPage("api-reference/chat/completions", "---\ntitle: \"Chat Completions\"\n---\nСоздаёт ответ модели. Аудио на вход поддерживают не все модели."),
      parseDocsPage("gaidy/limits", "Лимиты запросов и размер файла."),
    ],
  };

  it("reads the front matter and ranks pages by title, path and text", () => {
    expect(docs.pages[0]).toMatchObject({ title: "POST Audio Transcriptions", description: "Транскрибация аудио в текст" });
    expect(docs.pages[1]!.title).toBe("Chat Completions");
    expect(docs.pages[2]!.title).toBe("gaidy/limits");
    const hits = searchPolzaDocs(docs, "audio transcriptions base64");
    expect(hits[0]!.path).toBe("api-reference/audio/transcriptions");
    expect(hits[0]!.excerpt).toContain("base64");
    expect(searchPolzaDocs(docs, "вебхуки")).toEqual([]);
    expect(searchPolzaDocs(docs, " ")).toEqual([]);
  });

  it("finds a page by path, URL or file name", () => {
    expect(findPolzaDocsPage(docs, "https://polza.ai/docs/gaidy/limits")?.path).toBe("gaidy/limits");
    expect(findPolzaDocsPage(docs, "/api-reference/chat/completions.md")?.title).toBe("Chat Completions");
    expect(findPolzaDocsPage(docs, "nope")).toBeNull();
  });

  it("downloads the export once and caches it", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      json({ release: 2, publishedAt: "2026-11-11", navigation: {}, pages: { "a/b": "---\ntitle: B\n---\ntext" } }),
    );
    const store = new PolzaDocsStore(api(fetchImpl));
    expect((await store.get()).pages[0]).toMatchObject({ path: "a/b", title: "B", body: "text" });
    await store.get();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://polza.ai/api/v1/docs/export");
  });
});

describe("PolzaBalanceWatch", () => {
  const account = (available: number | null, limit: number | null = null, remaining: number | null = null): PolzaAccount => ({
    ...SIGNED_OUT_ACCOUNT,
    signedIn: true,
    balance: { amount: available, available: remaining ?? available, updatedAt: null },
    keyLimit: { limit, remaining, reset: "daily", usageDaily: null, usageMonthly: null, usageTotal: null },
  });

  it("alerts once per dip and re-arms after a top-up", () => {
    const watch = new PolzaBalanceWatch();
    expect(watch.check(account(500), 100)).toEqual([]);
    const first = watch.check(account(80), 100);
    expect(first.map((alert) => alert.kind)).toEqual(["balance"]);
    expect(first[0]!.title).toContain("80");
    expect(watch.check(account(60), 100)).toEqual([]);
    // Hovering just above the line does not re-arm: no flapping.
    expect(watch.check(account(105), 100)).toEqual([]);
    expect(watch.check(account(90), 100)).toEqual([]);
    expect(watch.check(account(1000), 100)).toEqual([]);
    expect(watch.check(account(50), 100)).toHaveLength(1);
  });

  it("alerts when under a tenth of the key limit is left", () => {
    const watch = new PolzaBalanceWatch();
    expect(watch.check(account(5000, 100, 40), 100)).toEqual([]);
    const alerts = watch.check(account(5000, 100, 7), 100);
    expect(alerts.map((alert) => alert.kind)).toEqual(["key-limit"]);
    expect(alerts[0]!.body).toContain("resets tomorrow");
    expect(watch.check(account(5000, 100, 3), 100)).toEqual([]);
  });

  it("stays quiet when signed out, turned off or the figures are unknown, and remembers sent alerts", () => {
    expect(new PolzaBalanceWatch().check(SIGNED_OUT_ACCOUNT, 100)).toEqual([]);
    expect(new PolzaBalanceWatch().check(account(1), 0)).toEqual([]);
    expect(new PolzaBalanceWatch().check(account(null), 100)).toEqual([]);
    const restored = new PolzaBalanceWatch(["balance"]);
    expect(restored.check(account(10), 100)).toEqual([]);
    expect(restored.activeKinds()).toEqual(["balance"]);
  });
});

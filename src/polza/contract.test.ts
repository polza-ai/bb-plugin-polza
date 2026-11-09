import { describe, expect, it } from "vitest";
import {
  estimatePolzaCostRub,
  formatPolzaPriceLabel,
  parsePolzaCatalog,
  parsePolzaModelList,
} from "./contract.js";
import { PolzaCostTracker, toPolzaTokenCounts } from "./cost.js";

const catalogResponse = {
  object: "list",
  data: [
    {
      id: "anthropic/claude-sonnet-5.5",
      name: "Anthropic: Claude Sonnet 5.5",
      type: "chat",
      short_description: "Код и документы",
      context_length: 1_000_000,
      reasoning: { supported_efforts: ["max", "high", "low", "none"] },
      architecture: { input_modalities: ["text", "image"] },
      top_provider: {
        supported_parameters: ["tools", "max_tokens"],
        pricing: {
          prompt_per_million: "190.77031080",
          completion_per_million: "953.85155400",
          input_cache_read_per_million: "9.53851554",
          input_cache_write_per_million: "238.46288850",
          currency: "RUB",
        },
      },
    },
    { id: "openai/dall-e-3", name: "DALL·E 3", type: "image" },
    { id: "broken", name: "no vendor" },
    {
      id: "deepseek/deepseek-v4-pro",
      name: "DeepSeek: V4 Pro",
      type: "chat",
      top_provider: { supported_parameters: ["reasoning_effort"], pricing: null },
    },
  ],
};

describe("parsePolzaCatalog", () => {
  it("keeps chat models with prices and drops malformed or non-chat entries", () => {
    const models = parsePolzaCatalog(catalogResponse);
    expect(models.map((model) => model.id)).toEqual([
      "anthropic/claude-sonnet-5.5",
      "deepseek/deepseek-v4-pro",
    ]);
    const sonnet = models[0]!;
    expect(sonnet.pricing).toEqual({
      promptPerMillion: 190.7703108,
      completionPerMillion: 953.851554,
      cacheReadPerMillion: 9.53851554,
      cacheWritePerMillion: 238.4628885,
    });
    expect(sonnet.reasoningEfforts).toEqual(["max", "high", "low", "none"]);
    expect(sonnet.supportsTools).toBe(true);
    expect(models[1]!.pricing).toBeNull();
    expect(models[1]!.supportsReasoning).toBe(true);
  });

  it("returns nothing for a response without data", () => {
    expect(parsePolzaCatalog({ error: "nope" })).toEqual([]);
  });
});

describe("parsePolzaModelList", () => {
  it("accepts a JSON array of slugs, deduplicated, and rejects anything else", () => {
    expect(parsePolzaModelList('["a/b","c/d","a/b"]')).toEqual(["a/b", "c/d"]);
    expect(parsePolzaModelList('["not a slug"]')).toEqual([]);
    expect(parsePolzaModelList("{}")).toEqual([]);
    expect(parsePolzaModelList(undefined)).toEqual([]);
  });
});

describe("cost estimation", () => {
  const pricing = {
    promptPerMillion: 100,
    completionPerMillion: 1000,
    cacheReadPerMillion: 10,
    cacheWritePerMillion: 125,
  };

  it("prices each token class at its own rate", () => {
    expect(
      estimatePolzaCostRub(pricing, { input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, output: 1_000_000 }),
    ).toBe(1235);
    expect(estimatePolzaCostRub(null, { input: 1, cacheRead: 0, cacheWrite: 0, output: 0 })).toBeNull();
  });

  it("falls back to the prompt rate when cache prices are missing", () => {
    expect(
      estimatePolzaCostRub(
        { ...pricing, cacheReadPerMillion: null, cacheWritePerMillion: null },
        { input: 0, cacheRead: 1_000_000, cacheWrite: 1_000_000, output: 0 },
      ),
    ).toBe(200);
  });

  it("splits Claude's cached tokens into reads and writes when reported", () => {
    expect(
      toPolzaTokenCounts({
        totalTokens: 60,
        inputTokens: 10,
        cachedInputTokens: 30,
        cacheReadInputTokens: 20,
        cacheWriteInputTokens: 10,
        outputTokens: 20,
        reasoningOutputTokens: 0,
      }),
    ).toEqual({ input: 10, cacheRead: 20, cacheWrite: 10, output: 20 });
    expect(
      toPolzaTokenCounts({
        totalTokens: 60,
        inputTokens: 10,
        cachedInputTokens: 30,
        outputTokens: 20,
        reasoningOutputTokens: 0,
      }),
    ).toEqual({ input: 10, cacheRead: 30, cacheWrite: 0, output: 20 });
  });

  it("accumulates turns and flags unpriced models", () => {
    const tracker = new PolzaCostTracker(() => new Date("2026-11-09T12:00:00Z"));
    const usage = {
      totalTokens: 2_000_000,
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 1_000_000,
      reasoningOutputTokens: 0,
    };
    expect(tracker.record({ model: "a/b", pricing, usage })).toMatchObject({
      rub: 1100,
      lastTurnRub: 1100,
      unpriced: false,
      model: "a/b",
      updatedAt: "2026-11-09T12:00:00.000Z",
    });
    expect(tracker.record({ model: "c/d", pricing: null, usage })).toMatchObject({
      rub: 1100,
      lastTurnRub: 0,
      unpriced: true,
      tokens: { input: 2_000_000, output: 2_000_000 },
    });
  });
});

describe("formatPolzaPriceLabel", () => {
  it("shows input and output prices per million tokens", () => {
    expect(formatPolzaPriceLabel({ promptPerMillion: 190.77, completionPerMillion: 953.85, cacheReadPerMillion: null, cacheWritePerMillion: null }))
      .toMatch(/^191 ₽ \/ 954 ₽ за Mtok$/u);
    expect(formatPolzaPriceLabel(null)).toBeNull();
  });
});

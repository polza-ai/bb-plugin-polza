import { describe, expect, it, vi } from "vitest";
import { buildPolzaModelList, createPolzaCatalogMemo, toAvailableModel } from "./catalog.js";
import type { PolzaCatalogModel } from "./contract.js";
import { listPolzaBridgeModels, PolzaEmptyModelListError, readPolzaListEnv } from "../bridge/model-list.js";

function model(overrides: Partial<PolzaCatalogModel> & { id: string }): PolzaCatalogModel {
  return {
    name: overrides.id,
    shortDescription: null,
    vendor: overrides.id.split("/")[0] ?? "",
    contextLength: 200_000,
    maxCompletionTokens: null,
    supportsReasoning: false,
    reasoningEfforts: null,
    pricing: { promptPerMillion: 100, completionPerMillion: 500, cacheReadPerMillion: null, cacheWritePerMillion: null },
    inputModalities: ["text"],
    supportsTools: true,
    fz152Compliant: false,
    ...overrides,
  };
}

const catalog = [
  model({ id: "anthropic/claude-sonnet-5.5", name: "Anthropic: Claude Sonnet 5.5", reasoningEfforts: ["max", "high", "low", "none"], supportsReasoning: true }),
  model({ id: "openai/gpt-5.4", name: "OpenAI: GPT-5.4", supportsReasoning: true }),
  model({ id: "qwen/qwen3-coder-next", name: "Qwen: Qwen3 Coder Next", pricing: null }),
];

describe("buildPolzaModelList", () => {
  it("follows the whitelist order, defaults to the first entry and reports missing slugs", () => {
    const list = buildPolzaModelList({
      catalog,
      selection: ["openai/gpt-5.4", "vendor/gone", "anthropic/claude-sonnet-5.5", "openai/gpt-5.4"],
    });
    expect(list.models.map((entry) => entry.id)).toEqual(["openai/gpt-5.4", "anthropic/claude-sonnet-5.5"]);
    expect(list.models[0]!.isDefault).toBe(true);
    expect(list.models[1]!.isDefault).toBe(false);
    expect(list.missing).toEqual(["vendor/gone"]);
  });

  it("maps catalog efforts onto Claude Code's ladder and describes the price", () => {
    const sonnet = toAvailableModel(catalog[0]!, true);
    expect(sonnet.displayName).toBe("Claude Sonnet 5.5");
    expect(sonnet.supportedReasoningEfforts.map((effort) => effort.reasoningEffort)).toEqual(["low", "high", "max"]);
    expect(sonnet.defaultReasoningEffort).toBe("high");
    expect(sonnet.description).toContain("100 ₽ / 500 ₽ за Mtok");
    expect(sonnet.description).toContain("200K контекст");

    const gpt = toAvailableModel(catalog[1]!, false);
    expect(gpt.supportedReasoningEfforts.map((effort) => effort.reasoningEffort)).toEqual(["low", "medium", "high", "xhigh", "max"]);

    const qwen = toAvailableModel(catalog[2]!, false);
    expect(qwen.supportedReasoningEfforts.map((effort) => effort.reasoningEffort)).toEqual(["medium"]);
    expect(qwen.description).not.toContain("₽");
  });
});

describe("createPolzaCatalogMemo", () => {
  it("shares one load per base URL and keeps the last answer when a refresh fails", async () => {
    let now = 0;
    const load = vi.fn<(baseUrl: string) => Promise<PolzaCatalogModel[]>>().mockResolvedValue(catalog);
    const memo = createPolzaCatalogMemo({ load, now: () => now, ttlMs: 1000 });
    await Promise.all([memo.get("https://a"), memo.get("https://a")]);
    expect(load).toHaveBeenCalledTimes(1);
    now = 2000;
    load.mockRejectedValueOnce(new Error("offline"));
    await expect(memo.get("https://a")).resolves.toEqual(catalog);
    expect(memo.peek("https://a")).toEqual(catalog);
    expect(memo.peek("https://b")).toBeNull();
  });
});

describe("listPolzaBridgeModels", () => {
  it("reads the whitelist and base URL from the contributed environment", async () => {
    expect(readPolzaListEnv({ POLZA_BASE_URL: "https://x/api", POLZA_MODELS: '["openai/gpt-5.4"]', POLZA_SIGNED_IN: "1" })).toEqual({
      baseUrl: "https://x/api",
      selection: ["openai/gpt-5.4"],
      signedIn: true,
    });
    expect(readPolzaListEnv(undefined)).toEqual({ baseUrl: "https://polza.ai/api", selection: [], signedIn: false });
  });

  it("refuses an empty whitelist with a typed error and lists the rest", async () => {
    const source = {
      resolve: vi.fn(async (_baseUrl: string, slugs: readonly string[]) => ({
        found: catalog.filter((model) => slugs.includes(model.id)),
        missing: slugs.filter((slug) => !catalog.some((model) => model.id === slug)),
      })),
    };
    await expect(listPolzaBridgeModels({}, source)).rejects.toBeInstanceOf(PolzaEmptyModelListError);
    const result = await listPolzaBridgeModels({ POLZA_MODELS: '["qwen/qwen3-coder-next"]' }, source);
    expect(result.models.map((entry) => entry.id)).toEqual(["qwen/qwen3-coder-next"]);
    expect(source.resolve).toHaveBeenCalledWith("https://polza.ai/api", ["qwen/qwen3-coder-next"]);
    await expect(listPolzaBridgeModels({ POLZA_MODELS: '["vendor/gone"]' }, source)).rejects.toThrow(/vendor\/gone/u);
  });
});

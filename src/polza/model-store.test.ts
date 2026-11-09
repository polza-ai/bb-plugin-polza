import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PolzaCatalogModel } from "./contract.js";
import { PolzaModelStore, fetchPolzaModels, PolzaModelNotFoundError } from "./model-store.js";

function model(id: string, promptPerMillion = 100): PolzaCatalogModel {
  return {
    id,
    name: id,
    shortDescription: null,
    vendor: id.split("/")[0] ?? "",
    contextLength: 100_000,
    maxCompletionTokens: null,
    supportsReasoning: false,
    reasoningEfforts: null,
    pricing: { promptPerMillion, completionPerMillion: 500, cacheReadPerMillion: null, cacheWritePerMillion: null },
    inputModalities: ["text"],
    supportsTools: true,
    fz152Compliant: false,
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("PolzaModelStore", () => {
  it("fetches only stale or unknown slugs, keeps missing ones and serves stale facts when offline", async () => {
    let now = 0;
    const load = vi.fn(async (slugs: readonly string[]) => ({
      found: slugs.filter((slug) => slug !== "x/gone").map((slug) => model(slug)),
      missing: slugs.filter((slug) => slug === "x/gone"),
    }));
    const store = new PolzaModelStore({ ttlMs: 1000, now: () => now, load });
    const first = await store.resolve("https://polza.ai/api", ["a/one", "x/gone"]);
    expect(first.found.map((entry) => entry.id)).toEqual(["a/one"]);
    expect(first.missing).toEqual(["x/gone"]);
    expect(load).toHaveBeenCalledTimes(1);

    await store.resolve("https://polza.ai/api", ["a/one", "b/two"]);
    expect(load).toHaveBeenLastCalledWith(["b/two"], "https://polza.ai/api");

    now = 5000;
    load.mockRejectedValueOnce(new Error("offline"));
    const stale = await store.resolve("https://polza.ai/api", ["a/one", "b/two"]);
    expect(stale.found.map((entry) => entry.id)).toEqual(["a/one", "b/two"]);

    load.mockRejectedValueOnce(new Error("offline"));
    await expect(store.resolve("https://polza.ai/api", ["c/new"])).rejects.toThrow("offline");
    expect(store.peek("https://polza.ai/api", "a/one")?.pricing?.promptPerMillion).toBe(100);
    expect(store.peek("https://other/api", "a/one")).toBeNull();
  });

  it("restores its snapshot from disk after a restart", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "polza-store-"));
    dirs.push(dataDir);
    const load = vi.fn(async (slugs: readonly string[]) => ({
      found: slugs.map((slug) => model(slug, 7)),
      missing: [],
    }));
    const first = new PolzaModelStore({ ttlMs: 60_000, dataDir, load });
    await first.resolve("https://polza.ai/api", ["a/one"]);

    const second = new PolzaModelStore({ ttlMs: 60_000, dataDir, load });
    expect(second.peek("https://polza.ai/api", "a/one")?.pricing?.promptPerMillion).toBe(7);
    await second.resolve("https://polza.ai/api", ["a/one"]);
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe("fetchPolzaModels", () => {
  it("asks for each slug and separates unknown models from failures", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/models/x/gone")) return new Response("{}", { status: 404 });
      if (url.endsWith("/v1/models/a/one")) {
        return new Response(
          JSON.stringify({ id: "a/one", name: "A: One", type: "chat", top_provider: { pricing: { prompt_per_million: "1", completion_per_million: "2" } } }),
          { status: 200 },
        );
      }
      return new Response("boom", { status: 500 });
    });
    const result = await fetchPolzaModels(["a/one", "x/gone"], { baseUrl: "https://polza.ai/api/", fetchImpl });
    expect(result.found.map((entry) => entry.id)).toEqual(["a/one"]);
    expect(result.missing).toEqual(["x/gone"]);
    expect(fetchImpl.mock.calls.map((call) => String(call[0])).sort()).toEqual([
      "https://polza.ai/api/v1/models/a/one",
      "https://polza.ai/api/v1/models/x/gone",
    ]);
    await expect(fetchPolzaModels(["b/err"], { fetchImpl })).rejects.toThrow(/HTTP 500/u);
    await expect(fetchPolzaModels(["x/gone"], { fetchImpl })).resolves.toEqual({ found: [], missing: ["x/gone"] });
    expect(new PolzaModelNotFoundError("q/w").message).toContain("q/w");
  });
});

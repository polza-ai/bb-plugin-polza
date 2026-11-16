import { describe, expect, it, vi } from "vitest";
import { PolzaBilledTracker, polzaGenerationId } from "./billing.js";

const api = (fetchImpl: typeof fetch) => ({
  baseUrl: () => "https://polza.ai/api",
  apiKey: () => "pza_test",
  fetchImpl,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("polzaGenerationId", () => {
  it("reads the generation id out of a Polza message id and ignores foreign ids", () => {
    expect(polzaGenerationId("msg_gen_2232447838685761538")).toBe("gen_2232447838685761538");
    expect(polzaGenerationId("gen_1")).toBe("gen_1");
    expect(polzaGenerationId("msg_01ABC")).toBeNull();
    expect(polzaGenerationId(null)).toBeNull();
  });
});

describe("PolzaBilledTracker", () => {
  it("sums finalized requests and keeps the rest pending", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url) =>
      String(url).endsWith("gen_1")
        ? json({ clientCost: "1.2500", finalizedAt: "2026-11-16T10:00:00Z" })
        : json({ clientCost: "0", finalizedAt: null }),
    );
    const tracker = new PolzaBilledTracker();
    expect(tracker.snapshot()).toBeNull();
    tracker.note("msg_gen_1");
    tracker.note("msg_gen_1");
    tracker.note("msg_gen_2");
    tracker.note("msg_synthetic");
    await tracker.reconcile(api(fetchImpl));
    expect(tracker.snapshot()).toEqual({ rub: 1.25, requests: 1, pending: 1 });
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://polza.ai/api/v1/history/generations/gen_1");

    fetchImpl.mockImplementation(async () => json({ clientCost: 0.5, finalizedAt: "2026-11-16T10:00:05Z" }));
    await tracker.reconcile(api(fetchImpl));
    expect(tracker.snapshot()).toEqual({ rub: 1.75, requests: 2, pending: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("stops asking after a refused key or repeated misses but still reports them pending", async () => {
    const refused = vi.fn<typeof fetch>().mockResolvedValue(json({ error: { message: "no" } }, 401));
    const tracker = new PolzaBilledTracker();
    tracker.note("msg_gen_1");
    await tracker.reconcile(api(refused));
    expect(tracker.hasOpen()).toBe(false);
    expect(tracker.snapshot()).toEqual({ rub: 0, requests: 0, pending: 1 });

    const missing = vi.fn<typeof fetch>().mockResolvedValue(json({}, 404));
    const second = new PolzaBilledTracker();
    second.note("msg_gen_2");
    for (let turn = 0; turn < 10; turn += 1) await second.reconcile(api(missing));
    expect(missing).toHaveBeenCalledTimes(6);
    expect(second.snapshot()).toEqual({ rub: 0, requests: 0, pending: 1 });
  });
});

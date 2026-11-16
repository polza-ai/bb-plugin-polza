// polza: what Polza actually charged for the requests of one bridge session.
// An assistant message id is `msg_<generation id>`; the generation's
// `clientCost` in the history API is the billed amount.
import { z } from "zod";
import { polzaRequest, PolzaApiError, type PolzaApiOptions } from "./http.js";

const generationSchema = z
  .object({
    clientCost: z.union([z.string(), z.number()]).nullish(),
    cost: z.union([z.string(), z.number()]).nullish(),
    finalizedAt: z.string().nullish(),
    status: z.string().nullish(),
  })
  .passthrough();

export interface PolzaBilledState {
  /** Billed rubles of the requests Polza has finalized. */
  rub: number;
  /** Requests counted in `rub`. */
  requests: number;
  /** Requests Polza has not finalized yet (or could not be looked up). */
  pending: number;
}

/** `msg_gen_123` → `gen_123`; null for ids Polza did not issue (synthetic messages). */
export function polzaGenerationId(messageId: string | null | undefined): string | null {
  if (typeof messageId !== "string") return null;
  const id = messageId.startsWith("msg_") ? messageId.slice(4) : messageId;
  return /^gen_[A-Za-z0-9_-]+$/u.test(id) ? id : null;
}

/** Billed cost of one generation; null while Polza has not finalized it. */
export async function fetchPolzaGenerationCost(
  options: PolzaApiOptions,
  generationId: string,
  signal?: AbortSignal,
): Promise<number | null> {
  const body = await polzaRequest(
    options,
    `/v1/history/generations/${encodeURIComponent(generationId)}`,
    signal ? { signal } : {},
  );
  const parsed = generationSchema.safeParse(body);
  if (!parsed.success) return null;
  if (parsed.data.finalizedAt === null || parsed.data.finalizedAt === undefined) return null;
  const raw = parsed.data.clientCost ?? parsed.data.cost;
  const rub = typeof raw === "number" ? raw : Number.parseFloat(raw ?? "");
  return Number.isFinite(rub) && rub >= 0 ? rub : null;
}

const MAX_ATTEMPTS = 6;
const MAX_PARALLEL = 4;

/**
 * Collects generation ids as messages arrive and looks their cost up after
 * each turn. A request that Polza never finalizes stops being retried after a
 * few turns, so it stays in `pending` and the total is shown as incomplete.
 */
export class PolzaBilledTracker {
  private readonly open = new Map<string, number>();
  private readonly seen = new Set<string>();
  private rub = 0;
  private requests = 0;
  private abandoned = 0;
  private running: Promise<void> | null = null;

  note(messageId: string | null | undefined): void {
    const id = polzaGenerationId(messageId);
    if (id === null || this.seen.has(id)) return;
    this.seen.add(id);
    this.open.set(id, 0);
  }

  snapshot(): PolzaBilledState | null {
    if (this.seen.size === 0) return null;
    return {
      rub: Math.round(this.rub * 10_000) / 10_000,
      requests: this.requests,
      pending: this.open.size + this.abandoned,
    };
  }

  /** True when a lookup could still change the snapshot. */
  hasOpen(): boolean {
    return this.open.size > 0;
  }

  reconcile(options: PolzaApiOptions, signal?: AbortSignal): Promise<void> {
    this.running ??= this.run(options, signal).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run(options: PolzaApiOptions, signal?: AbortSignal): Promise<void> {
    const ids = [...this.open.keys()];
    for (let start = 0; start < ids.length; start += MAX_PARALLEL) {
      await Promise.all(
        ids.slice(start, start + MAX_PARALLEL).map(async (id) => {
          let cost: number | null = null;
          try {
            cost = await fetchPolzaGenerationCost(options, id, signal);
          } catch (error) {
            // A revoked key will not start working: stop asking for this id.
            if (error instanceof PolzaApiError && (error.status === 401 || error.status === 403)) {
              this.open.delete(id);
              this.abandoned += 1;
              return;
            }
          }
          if (cost !== null) {
            this.open.delete(id);
            this.rub += cost;
            this.requests += 1;
            return;
          }
          const attempts = (this.open.get(id) ?? 0) + 1;
          if (attempts >= MAX_ATTEMPTS) {
            this.open.delete(id);
            this.abandoned += 1;
          } else {
            this.open.set(id, attempts);
          }
        }),
      );
    }
  }
}

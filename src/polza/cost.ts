// polza: running ruble estimate for one bridge attachment.
import type { ThreadEventTokenUsageBreakdown } from "@get-bb/plugin-sdk/provider-bridge";
import {
  estimatePolzaCostRub,
  type PolzaCostState,
  type PolzaModelPricing,
  type PolzaTokenCounts,
} from "./contract.js";

export interface PolzaCostRecordArgs {
  model: string | null;
  pricing: PolzaModelPricing | null;
  usage: ThreadEventTokenUsageBreakdown;
}

/**
 * Claude reports cache reads and writes separately when it knows them; when
 * it does not, `cachedInputTokens` is the only cached figure, so it counts as
 * reads (the cheaper rate), which keeps the estimate conservative.
 */
export function toPolzaTokenCounts(usage: ThreadEventTokenUsageBreakdown): PolzaTokenCounts {
  const cacheRead = usage.cacheReadInputTokens;
  const cacheWrite = usage.cacheWriteInputTokens;
  const splitKnown = cacheRead !== undefined || cacheWrite !== undefined;
  return {
    input: Math.max(0, usage.inputTokens),
    cacheRead: splitKnown ? Math.max(0, cacheRead ?? 0) : Math.max(0, usage.cachedInputTokens),
    cacheWrite: splitKnown ? Math.max(0, cacheWrite ?? 0) : 0,
    output: Math.max(0, usage.outputTokens),
  };
}

export class PolzaCostTracker {
  private rub = 0;
  private unpriced = false;
  private readonly tokens: PolzaTokenCounts = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  private readonly now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  record(args: PolzaCostRecordArgs): PolzaCostState {
    const counts = toPolzaTokenCounts(args.usage);
    this.tokens.input += counts.input;
    this.tokens.cacheRead += counts.cacheRead;
    this.tokens.cacheWrite += counts.cacheWrite;
    this.tokens.output += counts.output;
    const turnRub = estimatePolzaCostRub(args.pricing, counts);
    if (turnRub === null) {
      this.unpriced = true;
    } else {
      this.rub += turnRub;
    }
    return this.snapshot(args.model, turnRub ?? 0);
  }

  snapshot(model: string | null, lastTurnRub = 0): PolzaCostState {
    return {
      rub: round(this.rub),
      lastTurnRub: round(lastTurnRub),
      tokens: { ...this.tokens },
      model,
      unpriced: this.unpriced,
      updatedAt: this.now().toISOString(),
    };
  }
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

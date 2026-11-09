// polza: the signed-in account as the plugin shows it — who, how much is
// left on the organisation wallet, and how much the key may still spend.
import { z } from "zod";

const ACCOUNT_CACHE_TTL_MS = 20_000;
const REQUEST_TIMEOUT_MS = 12_000;

const rubString = z
  .union([z.string(), z.number()])
  .transform((value) => {
    const parsed = typeof value === "number" ? value : Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  });

const balanceSchema = z
  .object({
    amount: rubString.nullish(),
    available: rubString.nullish(),
    reservedAmount: rubString.nullish(),
    spentAmount: rubString.nullish(),
    updatedAt: z.string().nullish(),
  })
  .passthrough();

const keySchema = z
  .object({
    label: z.string().nullish(),
    limit: rubString.nullish(),
    limit_remaining: rubString.nullish(),
    limit_reset: z.string().nullish(),
    usage: rubString.nullish(),
    usage_daily: rubString.nullish(),
    usage_weekly: rubString.nullish(),
    usage_monthly: rubString.nullish(),
  })
  .passthrough();

const userInfoSchema = z
  .object({
    id: z.string().nullish(),
    name: z.string().nullish(),
    email: z.string().nullish(),
  })
  .passthrough();

export const polzaAccountSchema = z.object({
  signedIn: z.boolean(),
  user: z
    .object({
      id: z.string().nullable(),
      name: z.string().nullable(),
      email: z.string().nullable(),
    })
    .nullable(),
  keyLabel: z.string().nullable(),
  balance: z
    .object({
      /** Organisation wallet, rubles. */
      amount: z.number().nullable(),
      /** What a request may spend now (wallet minus reserves, capped by limits). */
      available: z.number().nullable(),
      updatedAt: z.string().nullable(),
    })
    .nullable(),
  keyLimit: z
    .object({
      limit: z.number().nullable(),
      remaining: z.number().nullable(),
      /** daily | weekly | monthly | never */
      reset: z.string().nullable(),
      usageDaily: z.number().nullable(),
      usageMonthly: z.number().nullable(),
      usageTotal: z.number().nullable(),
    })
    .nullable(),
  /** Set when the key was refused: the user must sign in again. */
  keyRevoked: z.boolean(),
  error: z.string().nullable(),
  fetchedAt: z.string().nullable(),
});

export type PolzaAccount = z.infer<typeof polzaAccountSchema>;

export const SIGNED_OUT_ACCOUNT: PolzaAccount = {
  signedIn: false,
  user: null,
  keyLabel: null,
  balance: null,
  keyLimit: null,
  keyRevoked: false,
  error: null,
  fetchedAt: null,
};

export interface PolzaAccountClientOptions {
  baseUrl: () => string;
  apiKey: () => string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

class PolzaHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class PolzaAccountClient {
  private cache: { account: PolzaAccount; expiresAt: number; key: string } | null = null;
  private pending: Promise<PolzaAccount> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: PolzaAccountClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  invalidate(): void {
    this.cache = null;
  }

  get(refresh = false): Promise<PolzaAccount> {
    const key = this.options.apiKey();
    if (key === null) {
      this.cache = null;
      return Promise.resolve(SIGNED_OUT_ACCOUNT);
    }
    if (
      !refresh &&
      this.cache !== null &&
      this.cache.key === key &&
      this.cache.expiresAt > this.now()
    ) {
      return Promise.resolve(this.cache.account);
    }
    if (this.pending !== null) return this.pending;
    this.pending = this.load(key)
      .then((account) => {
        this.cache = { account, key, expiresAt: this.now() + ACCOUNT_CACHE_TTL_MS };
        return account;
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }

  private async load(key: string): Promise<PolzaAccount> {
    const [balance, keyInfo, user] = await Promise.allSettled([
      this.request("/v2/balance", key, balanceSchema),
      this.request("/v1/key", key, keySchema),
      this.request("/auth/userinfo", key, userInfoSchema),
    ]);
    const revoked = [balance, keyInfo, user].some(
      (result) =>
        result.status === "rejected" &&
        result.reason instanceof PolzaHttpError &&
        (result.reason.status === 401 || result.reason.status === 403),
    );
    const firstError = [balance, keyInfo, user].find(
      (result) => result.status === "rejected",
    );
    return {
      signedIn: true,
      user:
        user.status === "fulfilled"
          ? {
              id: user.value.id ?? null,
              name: user.value.name ?? null,
              email: user.value.email ?? null,
            }
          : null,
      keyLabel: keyInfo.status === "fulfilled" ? (keyInfo.value.label ?? null) : null,
      balance:
        balance.status === "fulfilled"
          ? {
              amount: balance.value.amount ?? null,
              available: balance.value.available ?? null,
              updatedAt: balance.value.updatedAt ?? null,
            }
          : null,
      keyLimit:
        keyInfo.status === "fulfilled"
          ? {
              limit: keyInfo.value.limit ?? null,
              remaining: keyInfo.value.limit_remaining ?? null,
              reset: keyInfo.value.limit_reset ?? null,
              usageDaily: keyInfo.value.usage_daily ?? null,
              usageMonthly: keyInfo.value.usage_monthly ?? null,
              usageTotal: keyInfo.value.usage ?? null,
            }
          : null,
      keyRevoked: revoked,
      error:
        firstError !== undefined && firstError.status === "rejected"
          ? firstError.reason instanceof Error
            ? firstError.reason.message
            : String(firstError.reason)
          : null,
      fetchedAt: new Date(this.now()).toISOString(),
    };
  }

  private async request<T>(path: string, key: string, schema: z.ZodType<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(
        `${this.options.baseUrl().replace(/\/+$/u, "")}${path}`,
        {
          headers: { authorization: `Bearer ${key}`, accept: "application/json" },
          signal: controller.signal,
        },
      );
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        throw new PolzaHttpError(
          response.status,
          `Polza ${path} failed with HTTP ${response.status}${describe(body)}`,
        );
      }
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        throw new Error(`Polza ${path} returned an unexpected shape.`);
      }
      return parsed.data;
    } finally {
      clearTimeout(timer);
    }
  }
}

function describe(body: unknown): string {
  if (body && typeof body === "object") {
    const error = (body as Record<string, unknown>)["error"];
    if (error && typeof error === "object") {
      const message = (error as Record<string, unknown>)["message"];
      if (typeof message === "string") return `: ${message}`;
    }
  }
  return "";
}

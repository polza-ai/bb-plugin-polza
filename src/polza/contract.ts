// polza: shared vocabulary of the Polza provider. Imported by the server
// entry (bb server process), the bridge (host daemon) and the frontend
// (type-only), so keep it free of Node and React imports.
import { z } from "zod";

export const POLZA_PROVIDER_ID = "polza";
export const POLZA_DEFAULT_BASE_URL = "https://polza.ai/api";
export const POLZA_DASHBOARD_URL = "https://polza.ai/dashboard";

/** Extension state kind (declared as `cost`, emitted as `polza/cost`). */
export const POLZA_COST_STATE_NAME = "cost";
export const POLZA_COST_STATE_KIND = `${POLZA_PROVIDER_ID}/${POLZA_COST_STATE_NAME}`;

/** Non-secret values contributed to the bridge environment (model/list, health). */
export const POLZA_ENV = {
  baseUrl: "POLZA_BASE_URL",
  models: "POLZA_MODELS",
  signedIn: "POLZA_SIGNED_IN",
} as const;

/** The models offered after the first sign-in, in picker order. */
export const POLZA_STARTER_MODELS: readonly string[] = [
  "anthropic/claude-sonnet-5.5",
  "anthropic/claude-opus-5.5",
  "anthropic/claude-haiku-5.5",
  "openai/gpt-5.4",
  "google/gemini-3.1-pro-preview",
  "deepseek/deepseek-v4-pro",
  "qwen/qwen3-coder-next",
  "moonshotai/kimi-k3",
];

/** The cheap model Claude Code uses for side work (titles, descriptions). */
export const POLZA_DEFAULT_HAIKU_MODEL = "anthropic/claude-haiku-5.5";

export const polzaModelSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/iu, "Expected a <vendor>/<model> slug");

export const polzaModelListSchema = z.array(polzaModelSlugSchema).max(200);

/** Parses the whitelist setting; malformed input yields an empty list. */
export function parsePolzaModelList(raw: string | undefined | null): string[] {
  if (!raw) return [];
  try {
    const parsed = polzaModelListSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return [];
    return [...new Set(parsed.data)];
  } catch {
    return [];
  }
}

/** Secret-bearing options handed to the bridge on every session command. */
export const polzaProviderOptionsSchema = z
  .object({
    polzaApiKey: z.string().min(1).optional(),
    polzaBaseUrl: z.string().url().default(POLZA_DEFAULT_BASE_URL),
    polzaModels: polzaModelListSchema.default([]),
    polzaHaikuModel: polzaModelSlugSchema.optional(),
    polzaSubagentModel: polzaModelSlugSchema.optional(),
  })
  .passthrough();

export type PolzaProviderOptions = z.infer<typeof polzaProviderOptionsSchema>;

export const polzaCostStateSchema = z.object({
  /** Estimated spend of this bridge session, in rubles. */
  rub: z.number().nonnegative(),
  /** Spend of the latest turn, in rubles. */
  lastTurnRub: z.number().nonnegative(),
  tokens: z.object({
    input: z.number().nonnegative(),
    cacheRead: z.number().nonnegative(),
    cacheWrite: z.number().nonnegative(),
    output: z.number().nonnegative(),
  }),
  model: z.string().nullable(),
  /** True when a model had no catalog price and its tokens were not counted. */
  unpriced: z.boolean(),
  updatedAt: z.string(),
});

export type PolzaCostState = z.infer<typeof polzaCostStateSchema>;

/** Per-million-token prices in rubles, as the catalog reports them. */
export interface PolzaModelPricing {
  promptPerMillion: number;
  completionPerMillion: number;
  cacheReadPerMillion: number | null;
  cacheWritePerMillion: number | null;
}

export interface PolzaCatalogModel {
  id: string;
  name: string;
  shortDescription: string | null;
  vendor: string;
  contextLength: number | null;
  maxCompletionTokens: number | null;
  supportsReasoning: boolean;
  /** Effort ids the catalog lists for the model, in its own order. */
  reasoningEfforts: string[] | null;
  pricing: PolzaModelPricing | null;
  inputModalities: string[];
  supportsTools: boolean;
  fz152Compliant: boolean;
}

const decimalStringSchema = z
  .union([z.string(), z.number()])
  .transform((value) => {
    const parsed = typeof value === "number" ? value : Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  });

const pricingSchema = z
  .object({
    prompt_per_million: decimalStringSchema.nullish(),
    completion_per_million: decimalStringSchema.nullish(),
    input_cache_read_per_million: decimalStringSchema.nullish(),
    input_cache_write_per_million: decimalStringSchema.nullish(),
    currency: z.string().nullish(),
  })
  .passthrough();

const catalogEntrySchema = z
  .object({
    id: polzaModelSlugSchema,
    name: z.string().catch(""),
    type: z.string().catch("chat"),
    short_description: z.string().nullish(),
    context_length: z.number().nullish(),
    max_completion_tokens: z.number().nullish(),
    is_fz152_compliant: z.boolean().catch(false),
    reasoning: z
      .object({
        supported_efforts: z.array(z.string()).nullish(),
        default_effort: z.string().nullish(),
      })
      .passthrough()
      .nullish(),
    architecture: z
      .object({ input_modalities: z.array(z.string()).nullish() })
      .passthrough()
      .nullish(),
    top_provider: z
      .object({
        pricing: pricingSchema.nullish(),
        supported_parameters: z.array(z.string()).nullish(),
        context_length: z.number().nullish(),
        max_completion_tokens: z.number().nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

export const polzaCatalogResponseSchema = z
  .object({ data: z.array(z.unknown()) })
  .passthrough();

function toPricing(
  raw: z.infer<typeof pricingSchema> | null | undefined,
): PolzaModelPricing | null {
  if (!raw) return null;
  const prompt = raw.prompt_per_million ?? null;
  const completion = raw.completion_per_million ?? null;
  if (prompt === null || completion === null) return null;
  return {
    promptPerMillion: prompt,
    completionPerMillion: completion,
    cacheReadPerMillion: raw.input_cache_read_per_million ?? null,
    cacheWritePerMillion: raw.input_cache_write_per_million ?? null,
  };
}

/** Parses one `GET /v1/models` response; malformed entries are dropped. */
export function parsePolzaCatalog(raw: unknown): PolzaCatalogModel[] {
  const envelope = polzaCatalogResponseSchema.safeParse(raw);
  if (!envelope.success) return [];
  const models: PolzaCatalogModel[] = [];
  for (const entry of envelope.data.data) {
    const parsed = catalogEntrySchema.safeParse(entry);
    if (!parsed.success || parsed.data.type !== "chat") continue;
    const model = parsed.data;
    const efforts = model.reasoning?.supported_efforts?.filter(
      (effort) => effort.trim().length > 0,
    );
    const supportedParameters = model.top_provider?.supported_parameters ?? [];
    models.push({
      id: model.id,
      name: model.name || model.id,
      shortDescription: model.short_description?.trim() || null,
      vendor: model.id.split("/")[0] ?? "",
      contextLength: model.context_length ?? model.top_provider?.context_length ?? null,
      maxCompletionTokens:
        model.max_completion_tokens ?? model.top_provider?.max_completion_tokens ?? null,
      supportsReasoning:
        (efforts !== undefined && efforts !== null && efforts.length > 0) ||
        supportedParameters.includes("reasoning") ||
        supportedParameters.includes("reasoning_effort"),
      reasoningEfforts: efforts && efforts.length > 0 ? efforts : null,
      pricing: toPricing(model.top_provider?.pricing),
      inputModalities: model.architecture?.input_modalities ?? ["text"],
      supportsTools: supportedParameters.includes("tools"),
      fz152Compliant: model.is_fz152_compliant,
    });
  }
  return models;
}

export interface PolzaTokenCounts {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

/** Rubles for one request's token counts; null when the model has no price. */
export function estimatePolzaCostRub(
  pricing: PolzaModelPricing | null,
  tokens: PolzaTokenCounts,
): number | null {
  if (pricing === null) return null;
  const perToken = (perMillion: number | null, fallback: number) =>
    (perMillion ?? fallback) / 1_000_000;
  return (
    tokens.input * perToken(pricing.promptPerMillion, 0) +
    tokens.cacheRead * perToken(pricing.cacheReadPerMillion, pricing.promptPerMillion) +
    tokens.cacheWrite * perToken(pricing.cacheWritePerMillion, pricing.promptPerMillion) +
    tokens.output * perToken(pricing.completionPerMillion, 0)
  );
}

/** "190 ₽ / 954 ₽ за Mtok" style price label; null without a price. */
export function formatPolzaPriceLabel(pricing: PolzaModelPricing | null): string | null {
  if (pricing === null) return null;
  return `${formatRub(pricing.promptPerMillion)} / ${formatRub(pricing.completionPerMillion)} за Mtok`;
}

export function formatRub(amount: number): string {
  const abs = Math.abs(amount);
  const digits = abs >= 100 ? 0 : abs >= 1 ? 1 : 2;
  const text = amount.toLocaleString("ru-RU", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return `${text} ₽`;
}

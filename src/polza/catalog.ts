// polza: the Polza model catalog as the bridge and the server see it.
import {
  HIGH_REASONING_EFFORT,
  LOW_REASONING_EFFORT,
  MAX_REASONING_EFFORT,
  MEDIUM_REASONING_EFFORT,
  XHIGH_REASONING_EFFORT,
  type AvailableModel,
  type ModelReasoningEffort,
} from "@get-bb/plugin-sdk/provider-bridge";
import {
  POLZA_DEFAULT_BASE_URL,
  formatPolzaPriceLabel,
  parsePolzaCatalog,
  type PolzaCatalogModel,
} from "./contract.js";

const CATALOG_PATH = "/v1/models?type=chat";
const CATALOG_TIMEOUT_MS = 15_000;

export interface FetchPolzaCatalogArgs {
  baseUrl?: string | undefined;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/** Downloads the public chat catalog. Throws on network or HTTP failure. */
export async function fetchPolzaCatalog(
  args: FetchPolzaCatalogArgs = {},
): Promise<PolzaCatalogModel[]> {
  const base = (args.baseUrl ?? POLZA_DEFAULT_BASE_URL).replace(/\/+$/u, "");
  const fetchImpl = args.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS);
  args.signal?.addEventListener("abort", () => controller.abort(), { once: true });
  try {
    const response = await fetchImpl(`${base}${CATALOG_PATH}`, {
      headers: { accept: "application/json", "accept-language": "ru" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Polza catalog request failed with HTTP ${response.status}.`);
    }
    const models = parsePolzaCatalog(await response.json());
    if (models.length === 0) {
      throw new Error("Polza catalog returned no chat models.");
    }
    return models;
  } finally {
    clearTimeout(timer);
  }
}

export interface PolzaCatalogMemoOptions {
  load?: (baseUrl: string) => Promise<PolzaCatalogModel[]>;
  now?: () => number;
  ttlMs: number;
}

export interface PolzaCatalogMemo {
  get(baseUrl: string): Promise<PolzaCatalogModel[]>;
  /** The last successful answer for a base URL, if any; never fetches. */
  peek(baseUrl: string): PolzaCatalogModel[] | null;
}

/** Caches the catalog per base URL; a failed refresh keeps serving the last answer. */
export function createPolzaCatalogMemo({
  load = (baseUrl) => fetchPolzaCatalog({ baseUrl }),
  now = Date.now,
  ttlMs,
}: PolzaCatalogMemoOptions): PolzaCatalogMemo {
  const settled = new Map<string, { models: PolzaCatalogModel[]; expiresAt: number }>();
  const pending = new Map<string, Promise<PolzaCatalogModel[]>>();
  return {
    peek(baseUrl) {
      return settled.get(baseUrl)?.models ?? null;
    },
    get(baseUrl) {
      const cached = settled.get(baseUrl);
      if (cached !== undefined && cached.expiresAt > now()) {
        return Promise.resolve(cached.models);
      }
      const inFlight = pending.get(baseUrl);
      if (inFlight !== undefined) return inFlight;
      const promise = load(baseUrl)
        .then((models) => {
          settled.set(baseUrl, { models, expiresAt: now() + ttlMs });
          return models;
        })
        .catch((error: unknown) => {
          if (cached !== undefined) return cached.models;
          throw error;
        })
        .finally(() => {
          pending.delete(baseUrl);
        });
      pending.set(baseUrl, promise);
      return promise;
    },
  };
}

const STANDARD_EFFORTS: Record<string, ModelReasoningEffort> = {
  low: LOW_REASONING_EFFORT,
  medium: MEDIUM_REASONING_EFFORT,
  high: HIGH_REASONING_EFFORT,
  xhigh: XHIGH_REASONING_EFFORT,
  max: MAX_REASONING_EFFORT,
};

/** Claude Code accepts these effort levels on any model; other ids are dropped. */
const CLAUDE_EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"] as const;

function buildReasoningEfforts(model: PolzaCatalogModel): ModelReasoningEffort[] {
  const supported = new Set(
    (model.reasoningEfforts ?? (model.supportsReasoning ? [...CLAUDE_EFFORT_ORDER] : ["medium"]))
      .map((effort) => effort.toLowerCase()),
  );
  const efforts = CLAUDE_EFFORT_ORDER.filter((effort) => supported.has(effort)).map(
    (effort) => ({ ...STANDARD_EFFORTS[effort]! }),
  );
  return efforts.length > 0 ? efforts : [{ ...MEDIUM_REASONING_EFFORT }];
}

function pickDefaultEffort(efforts: readonly ModelReasoningEffort[]): string {
  const ids = efforts.map((effort) => effort.reasoningEffort);
  if (ids.includes("high")) return "high";
  if (ids.includes("medium")) return "medium";
  return ids[0] ?? "medium";
}

function displayName(model: PolzaCatalogModel): string {
  // "Anthropic: Claude Sonnet 5.5" → "Claude Sonnet 5.5"; the vendor is in the id.
  const withoutVendor = model.name.replace(/^[^:]{1,40}:\s*/u, "").trim();
  return withoutVendor.length > 0 ? withoutVendor : model.id;
}

function describe(model: PolzaCatalogModel): string {
  const parts = [model.id];
  const price = formatPolzaPriceLabel(model.pricing);
  if (price !== null) parts.push(price);
  if (model.contextLength !== null) {
    parts.push(`${Math.round(model.contextLength / 1000)}K контекст`);
  }
  if (model.shortDescription !== null) parts.push(model.shortDescription);
  return parts.join(" · ");
}

export function toAvailableModel(
  model: PolzaCatalogModel,
  isDefault: boolean,
): AvailableModel {
  const supportedReasoningEfforts = buildReasoningEfforts(model);
  return {
    id: model.id,
    model: model.id,
    displayName: displayName(model),
    description: describe(model),
    reasoningDiscovery: "known",
    supportedReasoningEfforts,
    defaultReasoningEffort: pickDefaultEffort(supportedReasoningEfforts),
    isDefault,
  };
}

export interface BuildPolzaModelListArgs {
  catalog: readonly PolzaCatalogModel[];
  /** Whitelisted slugs in picker order. */
  selection: readonly string[];
}

export interface PolzaModelListResult {
  models: AvailableModel[];
  selectedOnlyModels: AvailableModel[];
  /** Whitelisted slugs the catalog no longer lists. */
  missing: string[];
}

/**
 * The picker list: the whitelist in its own order, restricted to the catalog.
 * The first entry is the default. An empty whitelist offers nothing, so the
 * settings page is the one place models are chosen.
 */
export function buildPolzaModelList(args: BuildPolzaModelListArgs): PolzaModelListResult {
  const byId = new Map(args.catalog.map((model) => [model.id, model] as const));
  const models: AvailableModel[] = [];
  const missing: string[] = [];
  for (const slug of args.selection) {
    const model = byId.get(slug);
    if (model === undefined) {
      missing.push(slug);
      continue;
    }
    if (models.some((candidate) => candidate.id === slug)) continue;
    models.push(toAvailableModel(model, models.length === 0));
  }
  return { models, selectedOnlyModels: [], missing };
}

// polza: models Polza has retired and what it points to instead, so a
// retired model in the picker list is flagged with its successor.
import { z } from "zod";
import { polzaModelSlugSchema } from "./contract.js";
import { polzaRequest, type PolzaApiOptions } from "./http.js";

const replacementsSchema = z.object({
  data: z.array(z.object({ id: z.string(), replaced_by: z.string() }).passthrough()),
});

export const polzaRetiredModelSchema = z.object({
  id: z.string(),
  /** Successor model, when Polza names one. */
  replacedBy: z.string().nullable(),
  /** Catalog page to choose from when there is no single successor. */
  url: z.string().nullable(),
});
export type PolzaRetiredModel = z.infer<typeof polzaRetiredModelSchema>;

const SITE_ORIGIN = "https://polza.ai";
const TTL_MS = 60 * 60_000;

/** `replaced_by` is a model slug or a site path such as `/collections/text`. */
export function toRetiredModel(id: string, replacedBy: string): PolzaRetiredModel {
  if (replacedBy.startsWith("/")) return { id, replacedBy: null, url: `${SITE_ORIGIN}${replacedBy}` };
  const slug = polzaModelSlugSchema.safeParse(replacedBy);
  return slug.success
    ? { id, replacedBy: slug.data, url: null }
    : { id, replacedBy: null, url: `${SITE_ORIGIN}/models` };
}

export function findRetiredModels(
  selected: readonly string[],
  replacements: ReadonlyMap<string, string>,
): PolzaRetiredModel[] {
  return selected.flatMap((id) => {
    const replacedBy = replacements.get(id);
    return replacedBy === undefined ? [] : [toRetiredModel(id, replacedBy)];
  });
}

/** The picker list with each retired model swapped for its successor, order kept. */
export function applyReplacements(
  selected: readonly string[],
  retired: readonly PolzaRetiredModel[],
): string[] {
  const successor = new Map(retired.map((entry) => [entry.id, entry.replacedBy]));
  const next = selected.map((id) => successor.get(id) ?? id);
  return [...new Set(next)];
}

/** Public list, cached for an hour; a failed refresh serves the last answer. */
export class PolzaReplacements {
  private cache: { map: Map<string, string>; expiresAt: number; baseUrl: string } | null = null;
  private pending: Promise<Map<string, string>> | null = null;

  constructor(
    private readonly options: PolzaApiOptions,
    private readonly now: () => number = Date.now,
  ) {}

  async get(): Promise<ReadonlyMap<string, string>> {
    const baseUrl = this.options.baseUrl();
    if (this.cache !== null && this.cache.baseUrl === baseUrl && this.cache.expiresAt > this.now()) {
      return this.cache.map;
    }
    this.pending ??= this.load().finally(() => {
      this.pending = null;
    });
    try {
      const map = await this.pending;
      this.cache = { map, baseUrl, expiresAt: this.now() + TTL_MS };
      return map;
    } catch (error) {
      if (this.cache !== null && this.cache.baseUrl === baseUrl) return this.cache.map;
      throw error;
    }
  }

  private async load(): Promise<Map<string, string>> {
    const body = await polzaRequest(this.options, "/v1/models/replacements", {
      anonymous: true,
      signal: AbortSignal.timeout(12_000),
    });
    const parsed = replacementsSchema.parse(body);
    return new Map(parsed.data.map((entry) => [entry.id, entry.replaced_by]));
  }
}

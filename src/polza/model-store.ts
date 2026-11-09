// polza: per-model facts for the bridge. The whole catalog takes Polza
// 20–30 s to serve, so the bridge asks `GET /v1/models/{slug}` for the few
// whitelisted models (about a second each, in parallel) and remembers the
// answers on disk, so a bridge restart answers from the last known facts and
// refreshes in the background.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  POLZA_DEFAULT_BASE_URL,
  parsePolzaCatalogEntry,
  polzaModelSlugSchema,
  type PolzaCatalogModel,
} from "./contract.js";

const MODEL_REQUEST_TIMEOUT_MS = 20_000;
const MAX_PARALLEL_REQUESTS = 6;

export class PolzaModelNotFoundError extends Error {
  constructor(readonly slug: string) {
    super(`Polza has no chat model "${slug}".`);
    this.name = "PolzaModelNotFoundError";
  }
}

export interface FetchPolzaModelArgs {
  baseUrl?: string | undefined;
  fetchImpl?: typeof fetch;
}

/** Downloads one model's catalog entry. Throws PolzaModelNotFoundError on 404 or a non-chat entry. */
export async function fetchPolzaModel(
  slug: string,
  args: FetchPolzaModelArgs = {},
): Promise<PolzaCatalogModel> {
  const base = (args.baseUrl ?? POLZA_DEFAULT_BASE_URL).replace(/\/+$/u, "");
  const fetchImpl = args.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${base}/v1/models/${slug}`, {
      headers: { accept: "application/json", "accept-language": "ru" },
      signal: controller.signal,
    });
    if (response.status === 404) throw new PolzaModelNotFoundError(slug);
    if (!response.ok) {
      throw new Error(`Polza model lookup for ${slug} failed with HTTP ${response.status}.`);
    }
    const model = parsePolzaCatalogEntry(await response.json());
    if (model === null) throw new PolzaModelNotFoundError(slug);
    return model;
  } finally {
    clearTimeout(timer);
  }
}

export interface PolzaModelLookupResult {
  found: PolzaCatalogModel[];
  missing: string[];
}

export async function fetchPolzaModels(
  slugs: readonly string[],
  args: FetchPolzaModelArgs = {},
): Promise<PolzaModelLookupResult> {
  const found: PolzaCatalogModel[] = [];
  const missing: string[] = [];
  const queue = [...slugs];
  const worker = async () => {
    for (let slug = queue.shift(); slug !== undefined; slug = queue.shift()) {
      try {
        found.push(await fetchPolzaModel(slug, args));
      } catch (error) {
        if (error instanceof PolzaModelNotFoundError) {
          missing.push(slug);
          continue;
        }
        throw error;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(MAX_PARALLEL_REQUESTS, slugs.length) }, () => worker()),
  );
  return { found, missing };
}

const diskRecordSchema = z.object({
  savedAt: z.number(),
  models: z.record(z.string(), z.unknown()),
});

export interface PolzaModelStoreOptions {
  /** Where the on-disk snapshot lives; absent means memory only. */
  dataDir?: string | undefined;
  ttlMs: number;
  now?: () => number;
  load?: (slugs: readonly string[], baseUrl: string) => Promise<PolzaModelLookupResult>;
}

interface StoredModel {
  model: PolzaCatalogModel;
  fetchedAt: number;
}

/**
 * Model facts keyed by `baseUrl + slug`. `resolve` answers from fresh
 * entries, fetches stale or unknown ones, and when the network fails serves
 * whatever it still has (a stale answer beats no picker).
 */
export class PolzaModelStore {
  private readonly entries = new Map<string, StoredModel>();
  private readonly pending = new Map<string, Promise<PolzaModelLookupResult>>();
  private readonly now: () => number;
  private readonly load: NonNullable<PolzaModelStoreOptions["load"]>;
  private dataDir: string | undefined;
  private loadedFromDisk = false;

  constructor(private readonly options: PolzaModelStoreOptions) {
    this.now = options.now ?? Date.now;
    this.load =
      options.load ?? ((slugs, baseUrl) => fetchPolzaModels(slugs, { baseUrl }));
    this.dataDir = options.dataDir;
  }

  setDataDir(dataDir: string): void {
    this.dataDir = dataDir;
    this.loadedFromDisk = false;
  }

  /** The last known facts for a model, never fetching. */
  peek(baseUrl: string, slug: string): PolzaCatalogModel | null {
    this.restore();
    return this.entries.get(key(baseUrl, slug))?.model ?? null;
  }

  async resolve(baseUrl: string, slugs: readonly string[]): Promise<PolzaModelLookupResult> {
    this.restore();
    const unique = [...new Set(slugs)];
    const stale = unique.filter((slug) => {
      const entry = this.entries.get(key(baseUrl, slug));
      return entry === undefined || entry.fetchedAt + this.options.ttlMs <= this.now();
    });
    let missing: string[] = [];
    if (stale.length > 0) {
      try {
        const result = await this.loadOnce(baseUrl, stale);
        for (const model of result.found) {
          this.entries.set(key(baseUrl, model.id), { model, fetchedAt: this.now() });
        }
        missing = result.missing;
        this.persist();
      } catch (error) {
        // Serve what we have; fail only when a wanted model was never seen.
        const unknown = stale.filter((slug) => !this.entries.has(key(baseUrl, slug)));
        if (unknown.length > 0) throw error;
      }
    }
    const found = unique.flatMap((slug) => {
      const entry = this.entries.get(key(baseUrl, slug));
      return entry === undefined ? [] : [entry.model];
    });
    return {
      found,
      missing: unique.filter(
        (slug) => missing.includes(slug) || !this.entries.has(key(baseUrl, slug)),
      ),
    };
  }

  private loadOnce(baseUrl: string, slugs: string[]): Promise<PolzaModelLookupResult> {
    const pendingKey = key(baseUrl, slugs.join(","));
    const inFlight = this.pending.get(pendingKey);
    if (inFlight !== undefined) return inFlight;
    const promise = this.load(slugs, baseUrl).finally(() => {
      this.pending.delete(pendingKey);
    });
    this.pending.set(pendingKey, promise);
    return promise;
  }

  private snapshotPath(): string | null {
    return this.dataDir === undefined ? null : join(this.dataDir, "polza-models.json");
  }

  private restore(): void {
    if (this.loadedFromDisk) return;
    this.loadedFromDisk = true;
    const path = this.snapshotPath();
    if (path === null) return;
    try {
      const parsed = diskRecordSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
      if (!parsed.success) return;
      for (const [entryKey, raw] of Object.entries(parsed.data.models)) {
        const record = z
          .object({ model: z.unknown(), fetchedAt: z.number() })
          .safeParse(raw);
        if (!record.success) continue;
        const model = storedModelSchema.safeParse(record.data.model);
        if (!model.success || this.entries.has(entryKey)) continue;
        this.entries.set(entryKey, { model: model.data, fetchedAt: record.data.fetchedAt });
      }
    } catch {
      // No snapshot yet, or an unreadable one: start empty.
    }
  }

  private persist(): void {
    const path = this.snapshotPath();
    if (path === null) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(
        tmp,
        JSON.stringify({
          savedAt: this.now(),
          models: Object.fromEntries(this.entries),
        }),
      );
      renameSync(tmp, path);
    } catch {
      // The snapshot is an optimisation; losing it costs one refetch.
    }
  }
}

const storedModelSchema: z.ZodType<PolzaCatalogModel> = z.object({
  id: polzaModelSlugSchema,
  name: z.string(),
  shortDescription: z.string().nullable(),
  vendor: z.string(),
  contextLength: z.number().nullable(),
  maxCompletionTokens: z.number().nullable(),
  supportsReasoning: z.boolean(),
  reasoningEfforts: z.array(z.string()).nullable(),
  pricing: z
    .object({
      promptPerMillion: z.number(),
      completionPerMillion: z.number(),
      cacheReadPerMillion: z.number().nullable(),
      cacheWritePerMillion: z.number().nullable(),
    })
    .nullable(),
  inputModalities: z.array(z.string()),
  supportsTools: z.boolean(),
  fz152Compliant: z.boolean(),
});

function key(baseUrl: string, slug: string): string {
  return `${baseUrl.replace(/\/+$/u, "")} ${slug}`;
}

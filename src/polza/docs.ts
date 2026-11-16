// polza: the Polza documentation as a searchable set of pages for agents
// that write code against the Polza API.
import { z } from "zod";
import { polzaRequest, type PolzaApiOptions } from "./http.js";

const exportSchema = z
  .object({
    release: z.number(),
    publishedAt: z.string().optional(),
    pages: z.record(z.string(), z.string()),
  })
  .passthrough();

export interface PolzaDocsPage {
  path: string;
  title: string;
  description: string;
  body: string;
}

export interface PolzaDocs {
  release: number;
  pages: PolzaDocsPage[];
}

export interface PolzaDocsHit {
  path: string;
  title: string;
  description: string;
  excerpt: string;
}

const DOCS_SITE = "https://polza.ai/docs";
const TTL_MS = 6 * 60 * 60_000;

/** Splits Mintlify front matter (`title`, `description`) from the MDX body. */
export function parseDocsPage(path: string, mdx: string): PolzaDocsPage {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u.exec(mdx);
  const field = (name: string): string => {
    const line = new RegExp(`^${name}:\\s*(.+)$`, "mu").exec(match?.[1] ?? "");
    return (line?.[1] ?? "").trim().replace(/^["']|["']$/gu, "");
  };
  return {
    path,
    title: field("title") || path,
    description: field("description"),
    body: (match ? mdx.slice(match[0].length) : mdx).trim(),
  };
}

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}_./-]{2,}/gu) ?? [];
}

function count(haystack: string, needle: string): number {
  let hits = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
    hits += 1;
  }
  return hits;
}

/** Pages ranked by how often and where the query's words occur; title and path weigh most. */
export function searchPolzaDocs(docs: PolzaDocs, query: string, limit = 5): PolzaDocsHit[] {
  const terms = [...new Set(words(query))];
  if (terms.length === 0) return [];
  const scored = docs.pages.flatMap((page) => {
    const title = page.title.toLowerCase();
    const path = page.path.toLowerCase();
    const description = page.description.toLowerCase();
    const body = page.body.toLowerCase();
    let score = 0;
    let matched = 0;
    let firstAt = -1;
    for (const term of terms) {
      const inBody = count(body, term);
      const termScore =
        count(title, term) * 8 + count(path, term) * 6 + count(description, term) * 4 + Math.min(inBody, 10);
      if (termScore > 0) matched += 1;
      score += termScore;
      if (firstAt === -1 && inBody > 0) firstAt = body.indexOf(term);
    }
    if (score === 0) return [];
    // A page that covers every word outranks one that repeats a single word.
    return [{ page, score: score * (matched / terms.length), firstAt }];
  });
  scored.sort((a, b) => b.score - a.score || a.page.path.localeCompare(b.page.path));
  return scored.slice(0, limit).map(({ page, firstAt }) => {
    const start = Math.max(0, firstAt - 120);
    return {
      path: page.path,
      title: page.title,
      description: page.description,
      excerpt: page.body.slice(start, start + 360).replace(/\s+/gu, " ").trim(),
    };
  });
}

export function findPolzaDocsPage(docs: PolzaDocs, path: string): PolzaDocsPage | null {
  const wanted = path
    .trim()
    .replace(/^https?:\/\/polza\.ai\/docs\//u, "")
    .replace(/^\/+|\/+$/gu, "")
    .replace(/\.mdx?$/u, "");
  return docs.pages.find((page) => page.path === wanted) ?? null;
}

export function polzaDocsUrl(path: string): string {
  return `${DOCS_SITE}/${path}`;
}

/** The whole documentation is one public download (under 1 MB); cached for six hours. */
export class PolzaDocsStore {
  private cache: { docs: PolzaDocs; expiresAt: number; baseUrl: string } | null = null;
  private pending: Promise<PolzaDocs> | null = null;

  constructor(
    private readonly options: PolzaApiOptions,
    private readonly now: () => number = Date.now,
  ) {}

  async get(signal?: AbortSignal): Promise<PolzaDocs> {
    const baseUrl = this.options.baseUrl();
    if (this.cache !== null && this.cache.baseUrl === baseUrl && this.cache.expiresAt > this.now()) {
      return this.cache.docs;
    }
    this.pending ??= this.load().finally(() => {
      this.pending = null;
    });
    try {
      const docs = await this.pending;
      this.cache = { docs, baseUrl, expiresAt: this.now() + TTL_MS };
      return docs;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (this.cache !== null && this.cache.baseUrl === baseUrl) return this.cache.docs;
      throw error;
    }
  }

  private async load(): Promise<PolzaDocs> {
    const body = await polzaRequest(this.options, "/v1/docs/export", {
      anonymous: true,
      signal: AbortSignal.timeout(45_000),
    });
    const parsed = exportSchema.parse(body);
    return {
      release: parsed.release,
      pages: Object.entries(parsed.pages).map(([path, mdx]) => parseDocsPage(path, mdx)),
    };
  }
}

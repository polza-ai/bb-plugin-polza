// polza: one JSON request to the Polza API with the error text Polza sent.
export interface PolzaApiOptions {
  baseUrl: () => string;
  apiKey: () => string | null;
  fetchImpl?: typeof fetch;
}

export class PolzaApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "PolzaApiError";
  }
}

export interface PolzaRequestInit {
  method?: "GET" | "POST";
  /** A JSON value, or a FormData for uploads. */
  body?: unknown;
  signal?: AbortSignal;
  /** Public endpoints (catalog, docs) are called without the key. */
  anonymous?: boolean;
}

export async function polzaRequest(
  options: PolzaApiOptions,
  path: string,
  init: PolzaRequestInit = {},
): Promise<unknown> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (init.anonymous !== true) {
    const key = options.apiKey();
    if (key === null) throw new PolzaApiError(401, "Sign in with Polza first");
    headers["authorization"] = `Bearer ${key}`;
  }
  let body: BodyInit | undefined;
  if (init.body instanceof FormData) {
    body = init.body;
  } else if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${options.baseUrl().replace(/\/+$/u, "")}${path}`, {
    method: init.method ?? (body === undefined ? "GET" : "POST"),
    headers,
    ...(body !== undefined ? { body } : {}),
    ...(init.signal ? { signal: init.signal } : {}),
  });
  const parsed: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new PolzaApiError(
      response.status,
      `Polza answered HTTP ${response.status}${describePolzaError(parsed)}`,
    );
  }
  return parsed;
}

/** `: <message>` from Polza's error body, or an empty string. */
export function describePolzaError(body: unknown): string {
  if (body && typeof body === "object") {
    const error = (body as Record<string, unknown>)["error"];
    if (error && typeof error === "object") {
      const message = (error as Record<string, unknown>)["message"];
      if (typeof message === "string") return `: ${message}`;
    }
    if (typeof error === "string" && error.length > 0) return `: ${error}`;
    const message = (body as Record<string, unknown>)["message"];
    if (typeof message === "string" && message.length > 0) return `: ${message}`;
  }
  return "";
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

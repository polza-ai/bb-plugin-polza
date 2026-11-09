// polza: "Sign in with Polza" — OAuth 2.0 authorization code with PKCE.
// There is no client id; the "token" response is a long-lived API key.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";

const LOGIN_SESSION_TTL_MS = 10 * 60_000;

const tokenResponseSchema = z
  .object({
    key: z.string().min(1),
    user_id: z.string().min(1).optional(),
  })
  .passthrough();

export interface PolzaOAuthStart {
  sessionId: string;
  authorizeUrl: string;
}

export interface PolzaOAuthResult {
  apiKey: string;
  userId: string | null;
}

export interface PolzaOAuthLoginOptions {
  baseUrl: () => string;
  callbackUrl: () => string;
  appName: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface LoginSession {
  sessionId: string;
  codeVerifier: string;
  state: string;
  callbackUrl: string;
  createdAt: number;
}

export class PolzaOAuthError extends Error {
  constructor(
    message: string,
    readonly code: "no_session" | "expired" | "state_mismatch" | "denied" | "exchange_failed" | "bad_input",
  ) {
    super(message);
    this.name = "PolzaOAuthError";
  }
}

/**
 * Extracts `code` and `state` from what the user pasted: a full callback
 * URL, a query string, or the bare code.
 */
export function parsePastedCallback(pasted: string): { code: string; state: string | null } {
  const text = pasted.trim();
  if (text.length === 0) {
    throw new PolzaOAuthError("Paste the code or the full callback address.", "bad_input");
  }
  const fromParams = (params: URLSearchParams) => {
    const error = params.get("error");
    if (error) {
      throw new PolzaOAuthError(
        error === "access_denied" ? "Access was denied on the Polza consent page." : `Polza returned error "${error}".`,
        "denied",
      );
    }
    const code = params.get("code");
    if (!code) {
      throw new PolzaOAuthError("The pasted address has no code parameter.", "bad_input");
    }
    return { code, state: params.get("state") };
  };
  if (/^https?:\/\//iu.test(text)) {
    return fromParams(new URL(text).searchParams);
  }
  if (text.includes("code=")) {
    return fromParams(new URLSearchParams(text.replace(/^\?/u, "")));
  }
  if (!/^[A-Za-z0-9._~-]{8,512}$/u.test(text)) {
    throw new PolzaOAuthError("That does not look like a Polza authorization code.", "bad_input");
  }
  return { code: text, state: null };
}

export class PolzaOAuthLogin {
  private session: LoginSession | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: PolzaOAuthLoginOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  start(): PolzaOAuthStart {
    const codeVerifier = randomBytes(48).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    const state = randomBytes(24).toString("base64url");
    const callbackUrl = this.options.callbackUrl();
    this.session = {
      sessionId: randomUUID(),
      codeVerifier,
      state,
      callbackUrl,
      createdAt: this.now(),
    };
    const url = new URL(`${apiBase(this.options.baseUrl())}/auth/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("callback_url", callbackUrl);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    url.searchParams.set("app_name", this.options.appName);
    return { sessionId: this.session.sessionId, authorizeUrl: url.toString() };
  }

  /** The state of the pending login, for the HTTP callback to match. */
  pendingState(): string | null {
    return this.currentSession()?.state ?? null;
  }

  cancel(): void {
    this.session = null;
  }

  /** Finishes the login from a browser callback or a pasted code. */
  async complete(input: { code: string; state: string | null }): Promise<PolzaOAuthResult> {
    const session = this.currentSession();
    if (session === null) {
      throw new PolzaOAuthError("No sign-in is in progress. Start again.", "no_session");
    }
    if (input.state !== null && input.state !== session.state) {
      throw new PolzaOAuthError("The sign-in state did not match. Start again.", "state_mismatch");
    }
    this.session = null;
    let response: Response;
    try {
      response = await this.fetchImpl(`${apiBase(this.options.baseUrl())}/auth/token`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code: input.code,
          code_verifier: session.codeVerifier,
          callback_url: session.callbackUrl,
        }),
      });
    } catch (error) {
      throw new PolzaOAuthError(
        `Could not reach Polza to exchange the code: ${error instanceof Error ? error.message : String(error)}`,
        "exchange_failed",
      );
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw new PolzaOAuthError(
        `Polza refused the code (HTTP ${response.status}): ${describeError(body)}`,
        "exchange_failed",
      );
    }
    const parsed = tokenResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new PolzaOAuthError("Polza returned an unexpected token response.", "exchange_failed");
    }
    return { apiKey: parsed.data.key, userId: parsed.data.user_id ?? null };
  }

  private currentSession(): LoginSession | null {
    if (this.session !== null && this.now() - this.session.createdAt >= LOGIN_SESSION_TTL_MS) {
      this.session = null;
    }
    return this.session;
  }
}

/** `https://polza.ai/api` → `https://polza.ai/api` (the auth routes live under `/api/auth`). */
function apiBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/u, "");
}

function describeError(body: unknown): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const error = record["error"];
    if (error && typeof error === "object") {
      const message = (error as Record<string, unknown>)["message"];
      if (typeof message === "string") return message;
    }
    if (typeof record["message"] === "string") return record["message"];
    if (typeof error === "string") return error;
  }
  return "no details";
}

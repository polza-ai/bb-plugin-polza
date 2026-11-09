import { describe, expect, it, vi } from "vitest";
import { PolzaOAuthLogin, parsePastedCallback } from "./oauth.js";

describe("parsePastedCallback", () => {
  it("accepts a full callback URL, a query string or a bare code", () => {
    expect(parsePastedCallback("http://127.0.0.1:38886/api/v1/plugins/polza/http/oauth/callback?code=abc12345&state=st")).toEqual({ code: "abc12345", state: "st" });
    expect(parsePastedCallback("?code=abc12345")).toEqual({ code: "abc12345", state: null });
    expect(parsePastedCallback("  abc12345-xyz  ")).toEqual({ code: "abc12345-xyz", state: null });
  });

  it("explains denials and junk", () => {
    expect(() => parsePastedCallback("https://x/cb?error=access_denied&state=s")).toThrow(/denied/u);
    expect(() => parsePastedCallback("hello world")).toThrow(/does not look like/u);
    expect(() => parsePastedCallback("")).toThrow(/Paste/u);
  });
});

describe("PolzaOAuthLogin", () => {
  const callbackUrl = "http://127.0.0.1:38886/api/v1/plugins/polza/http/oauth/callback";

  it("builds a PKCE authorize URL without a client id and exchanges the code for a key", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ key: "pza_new", user_id: "usr_1" }), { status: 200 }),
    );
    const login = new PolzaOAuthLogin({
      baseUrl: () => "https://polza.ai/api/",
      callbackUrl: () => callbackUrl,
      appName: "bb",
      fetchImpl,
    });
    const started = login.start();
    const url = new URL(started.authorizeUrl);
    expect(url.origin + url.pathname).toBe("https://polza.ai/api/auth/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("callback_url")).toBe(callbackUrl);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(url.searchParams.get("app_name")).toBe("bb");
    expect(url.searchParams.has("client_id")).toBe(false);
    expect(login.pendingState()).toBe(url.searchParams.get("state"));

    const result = await login.complete({ code: "code-1", state: url.searchParams.get("state") });
    expect(result).toEqual({ apiKey: "pza_new", userId: "usr_1" });
    const [tokenUrl, init] = fetchImpl.mock.calls[0]!;
    expect(tokenUrl).toBe("https://polza.ai/api/auth/token");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      grant_type: "authorization_code",
      code: "code-1",
      callback_url: callbackUrl,
    });
    expect(login.pendingState()).toBeNull();
  });

  it("rejects a mismatched state, an expired session and a refused exchange", async () => {
    let now = 0;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "invalid code" } }), { status: 400 }),
    );
    const login = new PolzaOAuthLogin({
      baseUrl: () => "https://polza.ai/api",
      callbackUrl: () => callbackUrl,
      appName: "bb",
      fetchImpl,
      now: () => now,
    });
    await expect(login.complete({ code: "x", state: null })).rejects.toThrow(/No sign-in/u);
    login.start();
    await expect(login.complete({ code: "x", state: "wrong" })).rejects.toThrow(/state/u);
    await expect(login.complete({ code: "x", state: null })).rejects.toThrow(/invalid code/u);
    login.start();
    now = 11 * 60_000;
    expect(login.pendingState()).toBeNull();
  });
});

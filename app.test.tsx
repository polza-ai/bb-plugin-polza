// @vitest-environment jsdom
import { cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { polzaRpcContract, type PolzaStatus } from "./src/polza/rpc";

afterEach(() => {
  cleanup();
});

const signedIn: PolzaStatus = {
  account: {
    signedIn: true,
    user: { id: "usr_1", name: "Ilya", email: "ilya@example.com" },
    keyLabel: "pza_AbCd••••1234",
    balance: { amount: 1500.5, available: 1234.56, updatedAt: "2026-11-09T10:00:00Z" },
    keyLimit: { limit: 100, remaining: 42.5, reset: "daily", usageDaily: 57.5, usageMonthly: 300, usageTotal: 900 },
    keyRevoked: false,
    error: null,
    fetchedAt: "2026-11-09T10:00:00Z",
  },
  models: ["anthropic/claude-sonnet-5.5", "vendor/gone"],
  baseUrl: "https://polza.ai/api",
  callbackUrl: "http://127.0.0.1:38886/api/v1/plugins/polza/http/oauth/callback",
  dashboardUrl: "https://polza.ai/dashboard",
  loginPending: false,
};

const catalog = {
  models: [
    {
      id: "anthropic/claude-sonnet-5.5",
      name: "Anthropic: Claude Sonnet 5.5",
      shortDescription: null,
      vendor: "anthropic",
      contextLength: 1_000_000,
      maxCompletionTokens: null,
      supportsReasoning: true,
      reasoningEfforts: ["high", "low"],
      pricing: { promptPerMillion: 190.77, completionPerMillion: 953.85, cacheReadPerMillion: null, cacheWritePerMillion: null },
      inputModalities: ["text"],
      supportsTools: true,
      fz152Compliant: false,
    },
    {
      id: "openai/gpt-5.4",
      name: "OpenAI: GPT-5.4",
      shortDescription: null,
      vendor: "openai",
      contextLength: 400_000,
      maxCompletionTokens: null,
      supportsReasoning: true,
      reasoningEfforts: null,
      pricing: null,
      inputModalities: ["text"],
      supportsTools: false,
      fz152Compliant: false,
    },
  ],
  fetchedAt: "2026-11-09T10:00:00Z",
};

// The app module must load after the test runtime is installed, so import it lazily.
async function loadSlots() {
  return loadPluginApp(() => import("./app"));
}

describe("the Polza frontend", () => {
  it("registers a settings section, a sidebar disclosure, a composer banner and a provider icon", async () => {
    const captured = await loadSlots();
    expect(captured.settingsSections.map((entry) => entry.id)).toEqual(["polza"]);
    expect(captured.experimentalSidebarFooterItems.map((entry) => entry.id)).toEqual(["balance"]);
    expect(captured.composerCustomizations.map((entry) => entry.id)).toEqual(["cost"]);
  });

  it("renders the signed-in account, balance, key limit and the model whitelist with prices", async () => {
    const captured = await loadSlots();
    const section = captured.settingsSections[0]!;
    const rendered = renderSlot(section, {}, {
      experimental_rpcContract: polzaRpcContract,
      rpc: {
        "status.get": () => signedIn,
        "login.start": () => ({ sessionId: "s", authorizeUrl: "https://polza.ai/api/auth/authorize?x" }),
        "login.complete": () => signedIn,
        "login.cancel": () => ({ cancelled: false }),
        "account.logout": () => ({ ...signedIn, account: { ...signedIn.account, signedIn: false } }),
        "catalog.list": () => catalog,
        "models.set": ({ models }) => ({ models }),
      },
    });
    await waitFor(() => expect(rendered.getByText("ilya@example.com")).toBeTruthy());
    expect(rendered.getByText("Available balance")).toBeTruthy();
    expect(rendered.getByText(/1\s?235 ₽/u)).toBeTruthy();
    expect(rendered.getByText("Key limit left")).toBeTruthy();
    expect(rendered.getByText(/42,5 ₽/u)).toBeTruthy();
    await waitFor(() => expect(rendered.getAllByText("Anthropic: Claude Sonnet 5.5").length).toBeGreaterThan(0));
    expect(rendered.getByText(/not in the catalog/u)).toBeTruthy();
    expect(rendered.getAllByText(/191 ₽ \/ 954 ₽ per Mtok/u).length).toBeGreaterThan(0);
    expect(rendered.getByText("2 chat models")).toBeTruthy();
    rendered.unmount();
  });

  it("offers Sign in with Polza when nobody is signed in", async () => {
    const captured = await loadSlots();
    const section = captured.settingsSections[0]!;
    const rendered = renderSlot(section, {}, {
      experimental_rpcContract: polzaRpcContract,
      rpc: {
        "status.get": () => ({ ...signedIn, account: { ...signedIn.account, signedIn: false }, models: [] }),
        "login.start": () => ({ sessionId: "s", authorizeUrl: "https://polza.ai/api/auth/authorize?x" }),
        "login.complete": () => signedIn,
        "login.cancel": () => ({ cancelled: false }),
        "account.logout": () => signedIn,
        "catalog.list": () => catalog,
        "models.set": ({ models }) => ({ models }),
      },
    });
    await waitFor(() => expect(rendered.getByRole("button", { name: /Sign in with Polza/u })).toBeTruthy());
    expect(rendered.getByText(/No models selected/u)).toBeTruthy();
    rendered.unmount();
  });
});

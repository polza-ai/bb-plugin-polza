import { describe, expect, it } from "vitest";
import type { PluginProviderOptionsContext } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import polzaPlugin from "../server.js";
import { POLZA_ENV, POLZA_PROVIDER_ID } from "./polza/contract.js";

async function loadPolzaPlugin(settings: Record<string, string | boolean> = {}) {
  const host = createFakePluginHost({ pluginId: POLZA_PROVIDER_ID, settings });
  await polzaPlugin(host.bb);
  const declaration = host.harness.registrations.providerRegistrations.find(
    (entry) => entry.id === POLZA_PROVIDER_ID,
  );
  if (declaration === undefined) {
    throw new Error("expected the Polza provider to be registered");
  }
  return { declaration, host };
}

function providerOptions(
  declaration: Awaited<ReturnType<typeof loadPolzaPlugin>>["declaration"],
  settings: PluginProviderOptionsContext["settings"],
) {
  const deriveProviderOptions = declaration.deriveProviderOptions;
  if (deriveProviderOptions === undefined) {
    throw new Error("expected Polza provider options");
  }
  return deriveProviderOptions({
    threadId: "thread-1",
    projectId: "project-1",
    model: "anthropic/claude-sonnet-5.5",
    permissionMode: "accept-edits",
    settings,
  });
}

describe("the Polza provider declaration", () => {
  it("registers a host-scoped provider with health and installation but no usage", async () => {
    const { declaration } = await loadPolzaPlugin();
    expect(declaration.maintenance).toEqual({ health: true, usage: false, installation: true });
    expect(declaration.models).toEqual({ scope: "host" });
    expect(declaration.capabilities.supportsServiceTier).toBe(false);
    expect(Object.keys(declaration.extensionKinds ?? {})).toEqual(["cost"]);
  });

  it("hands the stored key, base URL and whitelist to the bridge as provider options", async () => {
    const { declaration } = await loadPolzaPlugin({
      apiKey: "pza_secret",
      baseUrl: "https://polza.example/api/",
      models: JSON.stringify(["openai/gpt-5.4", "anthropic/claude-sonnet-5.5"]),
      subagentModel: "anthropic/claude-haiku-5.5",
    });
    const options = providerOptions(declaration, {});
    expect(options).toMatchObject({
      polzaApiKey: "pza_secret",
      polzaBaseUrl: "https://polza.example/api",
      polzaModels: ["openai/gpt-5.4", "anthropic/claude-sonnet-5.5"],
      polzaSubagentModel: "anthropic/claude-haiku-5.5",
      chromeEnabled: false,
      artifactsEnabled: false,
      workflowsEnabled: false,
      sandboxEnabled: true,
    });
  });

  it("omits the key when nobody is signed in and keeps the picker options from settings", async () => {
    const { declaration } = await loadPolzaPlugin();
    const options = providerOptions(declaration, {
      sandboxEnabled: false,
      fullAccessApprovalsEnabled: true,
    });
    expect(options).not.toHaveProperty("polzaApiKey");
    expect(options).toMatchObject({
      polzaModels: [],
      sandboxEnabled: false,
      fullAccessApprovalsEnabled: true,
    });
    expect(providerOptions(declaration, {})).not.toHaveProperty("claudeCodePermissionMode");
  });

  it("contributes only non-secret routing facts to the bridge environment", async () => {
    const { host } = await loadPolzaPlugin({
      apiKey: "pza_secret",
      models: JSON.stringify(["openai/gpt-5.4"]),
    });
    const resolve = host.harness.registrations.providerEnvResolvers.get(POLZA_PROVIDER_ID);
    if (resolve === undefined) {
      throw new Error("expected a Polza env contribution");
    }
    const entries = await resolve({
      threadId: null,
      projectId: null,
      hostId: "host-1",
    });
    const byName = Object.fromEntries(entries.map((entry) => [entry.name, entry.value]));
    expect(byName[POLZA_ENV.models]).toBe(JSON.stringify(["openai/gpt-5.4"]));
    expect(byName[POLZA_ENV.signedIn]).toBe("1");
    expect(byName[POLZA_ENV.baseUrl]).toBe("https://polza.ai/api");
    expect(JSON.stringify(entries)).not.toContain("pza_secret");
  });
});

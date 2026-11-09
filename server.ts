// bb-plugin-polza — server entry (runs inside the bb server).
//
// Owns the Polza sign-in (OAuth PKCE), the API key (a secret setting), the
// model whitelist, balance lookups, and the `polza` provider declaration. The
// bridge that drives Claude Code lives in src/host.ts and runs on the host.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { PolzaAccountClient, SIGNED_OUT_ACCOUNT, type PolzaAccount } from "./src/polza/account.js";
import {
  POLZA_COST_STATE_NAME,
  POLZA_DASHBOARD_URL,
  POLZA_DEFAULT_BASE_URL,
  POLZA_DEFAULT_HAIKU_MODEL,
  POLZA_ENV,
  POLZA_PROVIDER_ID,
  POLZA_STARTER_MODELS,
  parsePolzaModelList,
  polzaCostStateSchema,
  polzaModelListSchema,
  polzaModelSlugSchema,
  type PolzaProviderOptions,
} from "./src/polza/contract.js";
import { createPolzaCatalogMemo } from "./src/polza/catalog.js";
import { PolzaOAuthError, PolzaOAuthLogin, parsePastedCallback } from "./src/polza/oauth.js";
import { POLZA_CHANGED_CHANNEL, polzaRpcContract, type PolzaStatus } from "./src/polza/rpc.js";
import { CLAUDE_NATIVE_ROOTS_DECLARATION } from "./src/native-roots.js";

export { polzaRpcContract } from "./src/polza/rpc.js";

const OAUTH_CALLBACK_PATH = "/oauth/callback";
const CATALOG_TTL_MS = 5 * 60_000;

const optionalSlug = z
  .string()
  .refine((value) => value.trim() === "" || polzaModelSlugSchema.safeParse(value).success, {
    message: "Expected a <vendor>/<model> slug or an empty value",
  });

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    apiKey: {
      type: "string",
      label: "Polza API key",
      description:
        "Filled by “Sign in with Polza”. You may also paste a key from polza.ai → Dashboard → API keys.",
      secret: true,
    },
    baseUrl: {
      type: "string",
      label: "Polza API base URL",
      description: "Change only for a self-hosted or staging Polza.",
      default: POLZA_DEFAULT_BASE_URL,
      experimental_schema: z.string().url(),
    },
    models: {
      type: "string",
      label: "Models in the picker",
      description:
        "JSON array of catalog slugs, in picker order; the first is the default. Edit it on the Polza settings page.",
      experimental_multiline: true,
      default: "[]",
      experimental_schema: z.string().refine(
        (value) => {
          try {
            return polzaModelListSchema.safeParse(JSON.parse(value)).success;
          } catch {
            return false;
          }
        },
        { message: "Expected a JSON array of <vendor>/<model> slugs" },
      ),
    },
    haikuModel: {
      type: "string",
      label: "Side-task model",
      description:
        "Cheap model Claude Code uses for titles, summaries and command descriptions.",
      default: POLZA_DEFAULT_HAIKU_MODEL,
      experimental_schema: optionalSlug,
    },
    subagentModel: {
      type: "string",
      label: "Subagent model",
      description: "Model for Claude Code subagents. Empty: the first model of the picker.",
      default: "",
      experimental_schema: optionalSlug,
    },
    memoryEnabled: {
      type: "boolean",
      label: "Claude Code memory",
      description: "Allow Claude Code to read and write its native auto-memory for Polza threads.",
      default: true,
    },
    sandboxEnabled: {
      type: "boolean",
      label: "Claude Code sandbox",
      description:
        "Run Bash commands in Claude Code's sandbox in Accept Edits and Approve for me modes.",
      default: true,
    },
    fullAccessApprovalsEnabled: {
      type: "boolean",
      label: "Approvals in Full Access",
      description:
        "Show Claude Code's own approval prompts in Full Access. Off approves every request, so unattended threads never wait.",
      default: false,
    },
    commandDescriptionsEnabled: {
      type: "boolean",
      label: "Command descriptions",
      description: "Title Bash command rows with Claude's short description instead of the command.",
      default: false,
    },
  });

  // The key is a secret: read once, kept in memory so deriveProviderOptions
  // (synchronous, called on every command) can hand it to the bridge.
  let current = await settings.get();
  settings.onChange((next) => {
    const keyChanged = next.apiKey !== current.apiKey;
    const modelsChanged = next.models !== current.models || next.baseUrl !== current.baseUrl;
    current = next;
    if (keyChanged) account.invalidate();
    if (keyChanged || modelsChanged) publishChanged();
  });

  const baseUrl = () => (current.baseUrl?.trim() || POLZA_DEFAULT_BASE_URL).replace(/\/+$/u, "");
  const apiKey = () => {
    const key = current.apiKey?.trim();
    return key && key.length > 0 ? key : null;
  };
  const selectedModels = () => parsePolzaModelList(current.models);
  const callbackUrl = () =>
    `${bb.server.loopbackBaseUrl.replace(/\/+$/u, "")}/api/v1/plugins/${bb.pluginId}/http${OAUTH_CALLBACK_PATH}`;

  const account = new PolzaAccountClient({ baseUrl, apiKey });
  const catalog = createPolzaCatalogMemo({ ttlMs: CATALOG_TTL_MS });
  const login = new PolzaOAuthLogin({ baseUrl, callbackUrl, appName: "bb" });

  function publishChanged(): void {
    bb.realtime.publish(POLZA_CHANGED_CHANNEL, { at: new Date().toISOString() });
  }

  async function status(refresh = false): Promise<PolzaStatus> {
    let accountState: PolzaAccount;
    try {
      accountState = await account.get(refresh);
    } catch (error) {
      bb.log.warn(`account lookup failed: ${String(error)}`);
      accountState = {
        ...SIGNED_OUT_ACCOUNT,
        signedIn: apiKey() !== null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    return {
      account: accountState,
      models: selectedModels(),
      baseUrl: baseUrl(),
      callbackUrl: callbackUrl(),
      dashboardUrl: POLZA_DASHBOARD_URL,
      loginPending: login.pendingState() !== null,
    };
  }

  async function storeKey(key: string): Promise<void> {
    const firstSignIn = apiKey() === null && selectedModels().length === 0;
    current = await settings.experimental_set({
      apiKey: key,
      ...(firstSignIn ? { models: JSON.stringify(POLZA_STARTER_MODELS) } : {}),
    });
    account.invalidate();
    publishChanged();
    bb.log.info(`signed in to Polza${firstSignIn ? " (starter models applied)" : ""}`);
  }

  async function completeLogin(input: { code: string; state: string | null }): Promise<void> {
    const result = await login.complete(input);
    await storeKey(result.apiKey);
  }

  // Browser callback of the PKCE flow. Reachable only when the browser can
  // open the bb server's loopback address; the settings page offers pasting
  // the code for every other setup. `state` ties the request to our session.
  bb.http.route(
    "GET",
    OAUTH_CALLBACK_PATH,
    async (c) => {
      const url = new URL(c.req.url);
      const state = url.searchParams.get("state");
      const expected = login.pendingState();
      if (expected === null || state !== expected) {
        return html(page("Sign-in link is stale", "Start the sign-in again from bb → Settings → Plugins → Polza."), 400);
      }
      const error = url.searchParams.get("error");
      if (error) {
        login.cancel();
        publishChanged();
        return html(page("Sign-in was cancelled", `Polza reported: ${escapeHtml(error)}. You can close this tab.`), 200);
      }
      const code = url.searchParams.get("code");
      if (!code) {
        return html(page("Missing code", "Polza did not send an authorization code."), 400);
      }
      try {
        await completeLogin({ code, state });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        bb.log.warn(`oauth callback failed: ${message}`);
        return html(page("Sign-in failed", escapeHtml(message)), 400);
      }
      return html(page("Signed in to Polza", "You can close this tab and return to bb."), 200);
    },
    { auth: "none" },
  );

  bb.rpc.register(polzaRpcContract, {
    "status.get": (input) => status(input?.refresh === true),
    "login.start": () => {
      const started = login.start();
      publishChanged();
      return started;
    },
    "login.complete": async ({ pasted }) => {
      try {
        await completeLogin(parsePastedCallback(pasted));
      } catch (cause) {
        if (cause instanceof PolzaOAuthError) throw new Error(cause.message);
        throw cause;
      }
      return status(true);
    },
    "login.cancel": () => {
      const pending = login.pendingState() !== null;
      login.cancel();
      if (pending) publishChanged();
      return { cancelled: pending };
    },
    "account.logout": async () => {
      current = await settings.experimental_set({ apiKey: null });
      account.invalidate();
      publishChanged();
      return status();
    },
    "catalog.list": async (input) => {
      const models = await catalog.get(baseUrl() + (input?.refresh ? "" : ""));
      return { models, fetchedAt: new Date().toISOString() };
    },
    "models.set": async ({ models }) => {
      const unique = [...new Set(models)];
      current = await settings.experimental_set({ models: JSON.stringify(unique) });
      publishChanged();
      return { models: unique };
    },
  });

  // Non-secret routing facts for the bridge's sessionless requests
  // (`model/list` sees them as `envVars`). Changing them changes the bridge
  // fingerprint, so the cached picker list is rebuilt.
  bb.providers.experimental_contributeEnv(POLZA_PROVIDER_ID, () => [
    {
      name: POLZA_ENV.baseUrl,
      value: baseUrl(),
      reason: "Polza API base URL for the model catalog",
    },
    {
      name: POLZA_ENV.models,
      value: JSON.stringify(selectedModels()),
      reason: "Models chosen for the picker in the Polza plugin settings",
    },
    {
      name: POLZA_ENV.signedIn,
      value: apiKey() === null ? "0" : "1",
      reason: "Whether a Polza key is configured on the bb server",
    },
  ]);

  bb.providers.register({
    id: POLZA_PROVIDER_ID,
    displayName: "Polza",
    icon: "./icons/polza.svg",
    strings: {
      signInHint: "Sign in with Polza in Settings → Plugins → Polza.",
      expiredHint: "Your Polza key was revoked. Sign in again in Settings → Plugins → Polza.",
      installUrl: "https://polza.ai/docs/integracii/claude-code",
      planModeCopy: "Claude Code will plan without normal full-access execution.",
      iconTint: { light: "#B2F72A", dark: "#B2F72A" },
    },
    ...CLAUDE_NATIVE_ROOTS_DECLARATION,
    maintenance: { health: true, usage: false, installation: true },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: true,
      fork: "checkpoint",
      supportsManualCompaction: true,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      permissionModes: ["accept-edits", "auto", "full"],
      reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
    },
    reasoningLevels: [
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
      { id: "xhigh", label: "Extra High" },
      { id: "max", label: "Max" },
    ],
    composerActions: ["plan"],
    completedTurnDisplay: "flat",
    extensionKinds: {
      [POLZA_COST_STATE_NAME]: { state: polzaCostStateSchema },
    },
    env: { passthrough: ["BB_CLAUDE_CODE_EXECUTABLE"] },
    models: { scope: "host" },
    deriveProviderOptions(context) {
      const key = apiKey();
      const haiku = current.haikuModel?.trim();
      const subagent = current.subagentModel?.trim();
      const polza: PolzaProviderOptions = {
        ...(key !== null ? { polzaApiKey: key } : {}),
        polzaBaseUrl: baseUrl(),
        polzaModels: selectedModels(),
        ...(haiku ? { polzaHaikuModel: haiku } : {}),
        ...(subagent ? { polzaSubagentModel: subagent } : {}),
      };
      return {
        ...polza,
        memoryEnabled: context.settings.memoryEnabled !== false,
        providerSubagentsEnabled: true,
        workflowsEnabled: false,
        chromeEnabled: false,
        disable1MContext: false,
        artifactsEnabled: false,
        sandboxEnabled: context.settings.sandboxEnabled !== false,
        fullAccessApprovalsEnabled: context.settings.fullAccessApprovalsEnabled === true,
        commandDescriptionsEnabled: context.settings.commandDescriptionsEnabled === true,
        ...(context.promptMode === "plan" ? { claudeCodePermissionMode: "plan" } : {}),
      };
    },
  });

  bb.cli.register({
    name: "polza",
    summary: "Polza provider: sign-in status, balance and picker models",
    commands: [
      { name: "status", summary: "Account, balance and key limit", usage: "bb polza status [--json]" },
      {
        name: "models",
        summary: "Models offered in the picker; `set` replaces them",
        usage: "bb polza models [--json] | bb polza models set <slug> [<slug>…]",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const args = argv.filter((arg) => arg !== "--json");
      const [command, sub, ...rest] = args;
      if (command === "status" || command === undefined) {
        const state = await status(true);
        if (json) return { exitCode: 0, stdout: JSON.stringify(state) };
        return { exitCode: 0, stdout: formatStatus(state) };
      }
      if (command === "models" && sub === undefined) {
        const models = selectedModels();
        return {
          exitCode: 0,
          stdout: json ? JSON.stringify(models) : models.join("\n") || "No models selected.",
        };
      }
      if (command === "models" && sub === "set") {
        const parsed = polzaModelListSchema.safeParse(rest);
        if (!parsed.success || parsed.data.length === 0) {
          return { exitCode: 1, stderr: "Pass one or more <vendor>/<model> slugs." };
        }
        current = await settings.experimental_set({ models: JSON.stringify(parsed.data) });
        publishChanged();
        return { exitCode: 0, stdout: json ? JSON.stringify(parsed.data) : parsed.data.join("\n") };
      }
      return {
        exitCode: 1,
        stderr: "Usage:\n  bb polza status [--json]\n  bb polza models [--json]\n  bb polza models set <slug> [<slug>…]",
      };
    },
  });

  bb.onDispose(() => {
    login.cancel();
  });
}

function formatStatus(state: PolzaStatus): string {
  const lines: string[] = [];
  const a = state.account;
  if (!a.signedIn) {
    lines.push("Not signed in. Open Settings → Plugins → Polza.");
  } else {
    lines.push(`Signed in${a.user?.email ? ` as ${a.user.email}` : a.user?.name ? ` as ${a.user.name}` : ""}${a.keyLabel ? ` (key ${a.keyLabel})` : ""}`);
    if (a.balance) lines.push(`Balance: ${fmt(a.balance.available)} available of ${fmt(a.balance.amount)} RUB`);
    if (a.keyLimit && a.keyLimit.limit !== null) {
      lines.push(`Key limit: ${fmt(a.keyLimit.remaining)} of ${fmt(a.keyLimit.limit)} RUB left (${a.keyLimit.reset ?? "no reset"})`);
    }
    if (a.keyRevoked) lines.push("The key was refused by Polza: sign in again.");
    if (a.error) lines.push(`Warning: ${a.error}`);
  }
  lines.push(`Models: ${state.models.length === 0 ? "none selected" : state.models.join(", ")}`);
  return lines.join("\n");
}

function fmt(value: number | null): string {
  return value === null ? "?" : value.toFixed(2);
}

function html(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/gu, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)} · Polza for bb</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;background:#0f1115;color:#e6e6e6;display:grid;place-items:center;min-height:100vh;margin:0}
main{max-width:28rem;padding:2rem;border:1px solid #2a2f3a;border-radius:12px;background:#161a22}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0;color:#b5bcc9}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${body}</p></main></body></html>`;
}

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
  POLZA_DEFAULT_VOICE_MODEL,
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
import { registerPolzaAiService } from "./src/polza/ai-service.js";
import { PolzaBalanceWatch, type PolzaBalanceAlertKind } from "./src/polza/balance-watch.js";
import { fetchPolzaGenerationCost, polzaGenerationId } from "./src/polza/billing.js";
import { PolzaDocsStore } from "./src/polza/docs.js";
import { POLZA_DEFAULT_DIARIZE_MODEL, POLZA_DEFAULT_IMAGE_MODEL } from "./src/polza/media.js";
import { applyReplacements, findRetiredModels, PolzaReplacements, type PolzaRetiredModel } from "./src/polza/replacements.js";
import { PolzaTools } from "./src/polza/tools.js";

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
    aiServiceEnabled: {
      type: "boolean",
      label: "Thread titles and commit messages",
      description:
        "Offer Polza as bb's AI service for thread titles and commit messages (Settings → AI services). Uses the model below.",
      default: true,
    },
    aiServiceModel: {
      type: "string",
      label: "Model for titles and commit messages",
      description: "A cheap catalog model; a title costs a fraction of a kopeck.",
      default: POLZA_DEFAULT_HAIKU_MODEL,
      experimental_schema: optionalSlug,
    },
    voiceEnabled: {
      type: "boolean",
      label: "Voice input",
      description:
        "Offer Polza as bb's AI service for voice input (Settings → AI services). Uses the model below.",
      default: true,
    },
    voiceModel: {
      type: "string",
      label: "Model for voice input",
      description:
        "A speech-to-text catalog model. GigaAM-v3 is tuned for Russian; pick a Whisper model for other languages.",
      default: POLZA_DEFAULT_VOICE_MODEL,
      experimental_schema: optionalSlug,
    },
    voiceCleanupEnabled: {
      type: "boolean",
      label: "Correct dictated terms",
      description:
        "After recognition, the model for titles fixes code terms spelled by ear (\"сервер тэ эс\" → server.ts). Adds about a second; skipped when it would be late.",
      default: true,
    },
    imageModel: {
      type: "string",
      label: "Image model",
      description: "Model behind the polza_generate_image agent tool and `bb polza image`.",
      default: POLZA_DEFAULT_IMAGE_MODEL,
      experimental_schema: optionalSlug,
    },
    diarizeModel: {
      type: "string",
      label: "Model for recordings with speakers",
      description: "Model behind the polza_transcribe_recording agent tool and `bb polza transcribe`.",
      default: POLZA_DEFAULT_DIARIZE_MODEL,
      experimental_schema: optionalSlug,
    },
    balanceAlertRub: {
      type: "number",
      label: "Low balance alert, ₽",
      description:
        "Notify when the available balance drops under this amount, or under a tenth of the key limit is left. 0 turns the alerts off.",
      default: 100,
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
    const modelsChanged =
      next.models !== current.models ||
      next.baseUrl !== current.baseUrl ||
      next.aiServiceEnabled !== current.aiServiceEnabled ||
      next.aiServiceModel !== current.aiServiceModel ||
      next.voiceEnabled !== current.voiceEnabled ||
      next.voiceModel !== current.voiceModel;
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

  const aiServiceModel = () => current.aiServiceModel?.trim() || POLZA_DEFAULT_HAIKU_MODEL;
  const aiServiceEnabled = () => current.aiServiceEnabled !== false;
  const voiceModel = () => current.voiceModel?.trim() || POLZA_DEFAULT_VOICE_MODEL;
  const voiceEnabled = () => current.voiceEnabled !== false;
  const voiceCleanup = () => current.voiceCleanupEnabled !== false;
  const balanceAlertRub = () =>
    typeof current.balanceAlertRub === "number" && Number.isFinite(current.balanceAlertRub)
      ? current.balanceAlertRub
      : 100;

  const account = new PolzaAccountClient({ baseUrl, apiKey });
  const catalog = createPolzaCatalogMemo({ ttlMs: CATALOG_TTL_MS });
  const login = new PolzaOAuthLogin({ baseUrl, callbackUrl, appName: "bb" });
  const api = { baseUrl, apiKey };
  const replacements = new PolzaReplacements(api);
  const tools = new PolzaTools(bb, {
    api,
    docs: new PolzaDocsStore(api),
    imageModel: () => current.imageModel?.trim() || POLZA_DEFAULT_IMAGE_MODEL,
    voiceModel,
    diarizeModel: () => current.diarizeModel?.trim() || POLZA_DEFAULT_DIARIZE_MODEL,
  });

  async function retiredModels(): Promise<PolzaRetiredModel[]> {
    const selected = selectedModels();
    if (selected.length === 0) return [];
    try {
      return findRetiredModels(selected, await replacements.get());
    } catch (error) {
      bb.log.warn(`retired model lookup failed: ${String(error)}`);
      return [];
    }
  }

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
      aiService: { enabled: aiServiceEnabled(), model: aiServiceModel() },
      voice: { enabled: voiceEnabled(), model: voiceModel(), cleanup: voiceCleanup() },
      retired: await retiredModels(),
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
    "aiService.set": async ({ enabled, model }) => {
      current = await settings.experimental_set({
        ...(enabled !== undefined ? { aiServiceEnabled: enabled } : {}),
        ...(model !== undefined ? { aiServiceModel: model } : {}),
      });
      publishChanged();
      return { enabled: aiServiceEnabled(), model: aiServiceModel() };
    },
    "voice.set": async ({ enabled, model, cleanup }) => {
      current = await settings.experimental_set({
        ...(enabled !== undefined ? { voiceEnabled: enabled } : {}),
        ...(model !== undefined ? { voiceModel: model } : {}),
        ...(cleanup !== undefined ? { voiceCleanupEnabled: cleanup } : {}),
      });
      publishChanged();
      return { enabled: voiceEnabled(), model: voiceModel(), cleanup: voiceCleanup() };
    },
    "models.replaceRetired": async () => {
      const selected = selectedModels();
      const next = applyReplacements(selected, await retiredModels());
      if (next.join("\n") !== selected.join("\n")) {
        current = await settings.experimental_set({ models: JSON.stringify(next) });
        publishChanged();
      }
      return { models: next };
    },
    "models.set": async ({ models }) => {
      const unique = [...new Set(models)];
      current = await settings.experimental_set({ models: JSON.stringify(unique) });
      publishChanged();
      return { models: unique };
    },
  });

  registerPolzaAiService(bb, {
    baseUrl,
    apiKey,
    model: aiServiceModel,
    enabled: aiServiceEnabled,
    voiceModel,
    voiceEnabled,
    voiceCleanup,
  });
  tools.registerAgentTools();

  // Low balance and key limit: checked on a schedule, announced once per dip
  // through bb's notification channels. Which alerts are out survives reloads.
  const BALANCE_ALERTS_KEY = "balance-alerts";
  const alertKinds = z.array(z.enum(["balance", "key-limit"]));
  let balanceWatch: PolzaBalanceWatch | null = null;
  async function checkBalance(): Promise<void> {
    if (apiKey() === null) return;
    if (balanceWatch === null) {
      const stored = alertKinds.safeParse(await bb.storage.kv.get<unknown>(BALANCE_ALERTS_KEY));
      balanceWatch = new PolzaBalanceWatch(stored.success ? stored.data : []);
    }
    const before = balanceWatch.activeKinds().join();
    const alerts = balanceWatch.check(await account.get(true), balanceAlertRub());
    if (balanceWatch.activeKinds().join() !== before) {
      await bb.storage.kv.set(BALANCE_ALERTS_KEY, balanceWatch.activeKinds() satisfies PolzaBalanceAlertKind[]);
      publishChanged();
    }
    for (const alert of alerts) {
      try {
        await bb.sdk.plugins.callRpc({
          pluginId: "push-notifications",
          method: "notifications.send",
          input: { title: alert.title, body: alert.body },
          outputSchema: z.object({ ok: z.literal(true) }).passthrough(),
        });
      } catch (error) {
        bb.log.warn(`could not send "${alert.title}": ${String(error)}`);
      }
    }
  }
  bb.background.schedule("balance-watch", "*/10 * * * *", checkBalance);

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
      { name: "status", summary: "Account, balance, key limit and retired models", usage: "bb polza status [--json]" },
      {
        name: "spend",
        summary: "Billed spend by the key today, this week and this month; or of one request",
        usage: "bb polza spend [--json] | bb polza spend <generation-id>",
      },
      {
        name: "image",
        summary: "Generate an image into a file",
        usage: "bb polza image <prompt> --out <path> [--size <WxH>] [--model <slug>]",
      },
      {
        name: "transcribe",
        summary: "Transcribe a recording, by default with speakers",
        usage: "bb polza transcribe <audio-file> [--no-speakers] [--out <text-file>] [--model <slug>]",
      },
      {
        name: "docs",
        summary: "Search the Polza API docs or read a page",
        usage: "bb polza docs <query> | bb polza docs --page <path> [--offset <n>]",
      },
      {
        name: "models",
        summary: "Models offered in the picker; `set` replaces them",
        usage: "bb polza models [--json] | bb polza models set <slug> [<slug>…]",
      },
    ],
    async run(argv, ctx) {
      const routed = await tools.runCli(argv, {
        ...(ctx.threadId !== undefined ? { threadId: ctx.threadId } : {}),
        ...(ctx.cwd !== undefined ? { cwd: ctx.cwd } : {}),
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      });
      if (routed !== null) return routed;
      const json = argv.includes("--json");
      const args = argv.filter((arg) => arg !== "--json");
      const [command, sub, ...rest] = args;
      if (command === "status" || command === undefined) {
        const state = await status(true);
        if (json) return { exitCode: 0, stdout: JSON.stringify(state) };
        return { exitCode: 0, stdout: formatStatus(state) };
      }
      if (command === "spend" && sub !== undefined) {
        const id = polzaGenerationId(sub);
        if (id === null) return { exitCode: 1, stderr: "Pass a generation id such as gen_123 (or a message id msg_gen_123)." };
        try {
          const rub = await fetchPolzaGenerationCost(api, id, ctx.signal);
          if (json) return { exitCode: 0, stdout: JSON.stringify({ id, rub, finalized: rub !== null }) };
          return { exitCode: 0, stdout: rub === null ? `${id}: not finalized yet` : `${id}: ${rub.toFixed(4)} RUB` };
        } catch (error) {
          return { exitCode: 1, stderr: error instanceof Error ? error.message : String(error) };
        }
      }
      if (command === "spend") {
        const state = await account.get(true);
        if (!state.signedIn) return { exitCode: 1, stderr: "Not signed in. Open Settings → Plugins → Polza." };
        const spend = {
          today: state.keyLimit?.usageDaily ?? null,
          week: state.keyLimit?.usageWeekly ?? null,
          month: state.keyLimit?.usageMonthly ?? null,
          total: state.keyLimit?.usageTotal ?? null,
        };
        if (json) return { exitCode: 0, stdout: JSON.stringify(spend) };
        return {
          exitCode: 0,
          stdout: `Billed to this key\nToday:      ${fmt(spend.today)} RUB\nThis week:  ${fmt(spend.week)} RUB\nThis month: ${fmt(spend.month)} RUB\nAll time:   ${fmt(spend.total)} RUB`,
        };
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
        stderr:
          "Usage:\n  bb polza status [--json]\n  bb polza spend [--json] | bb polza spend <generation-id>\n  bb polza models [--json]\n  bb polza models set <slug> [<slug>…]\n  bb polza image <prompt> --out <path>\n  bb polza transcribe <audio-file> [--no-speakers] [--out <text-file>]\n  bb polza docs <query> | bb polza docs --page <path>",
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
  for (const model of state.retired) {
    lines.push(
      `Retired: ${model.id} → ${model.replacedBy ?? `pick another at ${model.url}`}`,
    );
  }
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

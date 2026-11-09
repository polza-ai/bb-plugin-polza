// polza: the environment that points Claude Code at Polza.
import { POLZA_DEFAULT_HAIKU_MODEL, type PolzaProviderOptions } from "./contract.js";

export interface BuildPolzaSessionEnvArgs {
  options: PolzaProviderOptions;
}

/**
 * Variables merged over the Claude CLI environment. Anything the user set
 * for a standalone Claude Code (their own ANTHROPIC_* values) is overridden
 * so a Polza thread never bills another account.
 */
export function buildPolzaSessionEnv(args: BuildPolzaSessionEnvArgs): Record<string, string> {
  const { options } = args;
  const haiku = options.polzaHaikuModel ?? POLZA_DEFAULT_HAIKU_MODEL;
  // The selected model reaches the CLI as `--model`, never through the
  // environment: a model switch must not change the env signature, which
  // would rebuild the Claude session on every turn. Aliases follow the
  // whitelist's first entry instead.
  const primary = options.polzaModels[0] ?? haiku;
  const subagent = options.polzaSubagentModel ?? primary;
  return {
    ANTHROPIC_BASE_URL: options.polzaBaseUrl.replace(/\/+$/u, ""),
    ANTHROPIC_AUTH_TOKEN: options.polzaApiKey ?? "",
    // An explicit empty key keeps the CLI off api.anthropic.com (Polza docs).
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_DEFAULT_OPUS_MODEL: primary,
    ANTHROPIC_DEFAULT_SONNET_MODEL: primary,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: haiku,
    ANTHROPIC_SMALL_FAST_MODEL: haiku,
    CLAUDE_CODE_SUBAGENT_MODEL: subagent,
    // The CLI would otherwise refresh the machine's own claude.ai login while routed.
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
    // Tool search is disabled behind a custom base URL unless asked for.
    ENABLE_TOOL_SEARCH: "true",
    // No claude.ai account behind the key: skip telemetry and update nags.
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}

/** Names this plugin owns in a session environment, for signature checks. */
export const POLZA_SESSION_ENV_NAMES: readonly string[] = Object.keys(
  buildPolzaSessionEnv({
    options: { polzaBaseUrl: "https://polza.ai/api", polzaModels: [] },
  }),
);

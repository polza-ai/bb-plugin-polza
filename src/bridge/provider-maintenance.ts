import {
  type ProviderHealthResult,
  type ProviderInstallationRunResult,
  type ProviderInstallationStatus,
  type ProviderUsageResult,
  experimental_commandOutput as commandOutput,
  experimental_compareVersions as compareVersions,
  experimental_downloadedInstallerCommand as downloadedInstallerCommand,
  experimental_formatCommand as formatCommand,
  experimental_installationVerification as installationVerification,
  experimental_npmCommand as npmCommand,
  experimental_npmGlobalInstallSource as npmGlobalInstallSource,
  experimental_probeNpmGlobalPackage as probeNpmGlobalPackage,
  experimental_readCliVersion as readCliVersion,
  experimental_resolveExecutablePath as resolveExecutablePath,
  experimental_versionFrom as versionFrom,
} from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";

const CLAUDE_NPM_PACKAGE = "@anthropic-ai/claude-code";
const CLAUDE_INSTALL_SCRIPT_URL = "https://claude.ai/install.sh";
const CLAUDE_POWERSHELL_INSTALL_SCRIPT_URL = "https://claude.ai/install.ps1";

async function claudeExecutable(): Promise<string> {
  const explicit = process.env.BB_CLAUDE_CODE_EXECUTABLE?.trim();
  if (explicit) return explicit;
  return (await resolveExecutablePath("claude")) ?? "claude";
}

function claudeInstallerCommand() {
  return downloadedInstallerCommand(CLAUDE_INSTALL_SCRIPT_URL, {
    powershellUrl: CLAUDE_POWERSHELL_INSTALL_SCRIPT_URL,
  });
}

function claudeDistTags(value: string | null): {
  latest: string;
  stable: string | null;
} | null {
  if (value === null) return null;
  try {
    const distTagsSchema = z.object({
      latest: z.string().min(1),
      stable: z.string().min(1).optional(),
    });
    const parsed = z
      .union([
        distTagsSchema,
        z.tuple([distTagsSchema]).transform(([tags]) => tags),
      ])
      .safeParse(JSON.parse(value));
    if (!parsed.success) return null;
    const latest = versionFrom(parsed.data.latest);
    if (latest === null) return null;
    return {
      latest,
      stable:
        parsed.data.stable === undefined
          ? latest
          : versionFrom(parsed.data.stable),
    };
  } catch {
    return null;
  }
}

function claudeDoctor(value: string | null): {
  installMethod: "native" | "npm-global" | "package-manager" | "unknown" | null;
  updateChannel: "latest" | "stable" | null;
} {
  const running =
    value === null ? null : /^Running:\s+([^\s(]+)/mu.exec(value)?.[1];
  const channel =
    value === null
      ? null
      : /^Auto-update channel:\s+(latest|stable)\s*$/mu.exec(value)?.[1];
  return {
    installMethod:
      running === "native" || running === "npm-global"
        ? running
        : running !== null && running !== undefined
          ? ["homebrew", "winget", "apt", "dnf", "apk"].includes(running)
            ? "package-manager"
            : "unknown"
          : null,
    updateChannel:
      channel === "latest" || channel === "stable" ? channel : null,
  };
}

function isDefaultNativeClaudePath(executablePath: string | null): boolean {
  if (executablePath === null) return false;
  const normalized = executablePath.replace(/\\/gu, "/");
  return (
    normalized.endsWith("/.local/bin/claude") ||
    (process.platform === "win32" &&
      normalized.endsWith("/.local/bin/claude.exe"))
  );
}

export async function getClaudeProviderInstallationStatus(
  checkUpdates = true,
): Promise<ProviderInstallationStatus> {
  const command = await claudeExecutable();
  const [
    resolvedExecutable,
    versionOutput,
    tagsOutput,
    npmGlobal,
    doctorOutput,
  ] = await Promise.all([
    resolveExecutablePath(command),
    commandOutput(command, ["--version"]),
    checkUpdates
      ? commandOutput(npmCommand(), [
          "view",
          CLAUDE_NPM_PACKAGE,
          "dist-tags",
          "--json",
        ])
      : null,
    checkUpdates
      ? probeNpmGlobalPackage(CLAUDE_NPM_PACKAGE)
      : { npmBin: null, npmGlobalPackageVersion: null },
    checkUpdates ? commandOutput(command, ["doctor"]) : null,
  ]);
  const installed = resolvedExecutable !== null || versionOutput !== null;
  const currentVersion = versionFrom(versionOutput);
  const doctor = claudeDoctor(doctorOutput);
  const tags = claudeDistTags(tagsOutput);
  const latestVersion =
    doctor.updateChannel === null || tags === null
      ? null
      : tags[doctor.updateChannel];
  const definitelyNeedsUnknownChannelUpdate =
    installed &&
    currentVersion !== null &&
    tags?.stable !== null &&
    tags?.stable !== undefined &&
    compareVersions(tags.latest, currentVersion) > 0 &&
    compareVersions(tags.stable, currentVersion) > 0;
  const needsUpdate =
    installed && currentVersion !== null && latestVersion !== null
      ? compareVersions(latestVersion, currentVersion) > 0
      : definitelyNeedsUnknownChannelUpdate;
  const installSource = npmGlobalInstallSource({
    installed,
    executablePath: resolvedExecutable,
    npmBin: npmGlobal.npmBin,
  });
  const nativeFallback =
    doctor.installMethod === null &&
    installSource === "external" &&
    isDefaultNativeClaudePath(resolvedExecutable);
  const canRunUpdate =
    doctor.installMethod === "native" ||
    nativeFallback ||
    (installSource === "npmGlobal" &&
      (doctor.installMethod === null || doctor.installMethod === "npm-global"));
  const actionKind = !installed
    ? "install"
    : needsUpdate && canRunUpdate
      ? "update"
      : null;
  const displayCommand =
    actionKind === "install"
      ? claudeInstallerCommand().displayCommand
      : formatCommand(command, ["update"]);
  return {
    executableName: command,
    executablePath: resolvedExecutable,
    installed,
    installSource,
    currentVersion,
    latestVersion,
    minimumSupportedVersion: null,
    npmPackageName: CLAUDE_NPM_PACKAGE,
    npmGlobalPackageVersion: npmGlobal.npmGlobalPackageVersion,
    installAction:
      actionKind === null
        ? null
        : {
            kind: actionKind,
            label: actionKind === "install" ? "Install" : "Update",
            command: displayCommand,
          },
    needsUpdate,
    versionUnsupported: false,
  };
}

export async function getClaudeProviderInstallationRun(
  action: "install" | "update",
): Promise<ProviderInstallationRunResult> {
  const status = await getClaudeProviderInstallationStatus();
  return buildClaudeProviderInstallationRun(status, action);
}

function buildClaudeProviderInstallationRun(
  status: ProviderInstallationStatus,
  action: "install" | "update",
): ProviderInstallationRunResult {
  const command = status.executableName;
  if (status.installAction?.kind !== action) {
    return {
      available: false,
      message: `Claude Code ${action} is no longer available on this host.`,
    };
  }
  const execution =
    action === "install"
      ? claudeInstallerCommand()
      : {
          command,
          args: ["update"],
          displayCommand: formatCommand(command, ["update"]),
        };
  return {
    available: true,
    command: execution,
    verification: installationVerification(status, action),
  };
}

// polza: health asks only whether the Claude CLI is present. The sign-in
// state lives on the bb server (the Polza key is a plugin secret) and is shown
// by the plugin's own settings page and sidebar disclosure; the bridge never
// sees the key outside a session command.
function healthResult(
  status: "ready" | "not_installed",
  args: { installedVersion?: string | null } = {},
): ProviderHealthResult {
  return {
    supported: true,
    health: {
      status,
      statusMessage: null,
      accountEmail: null,
      planLabel: null,
      installedVersion: args.installedVersion ?? null,
      minimumSupportedVersion: null,
      canInstall: true,
      canUpdate: status !== "not_installed",
      loginCommand: null,
    },
  };
}

export async function getPolzaProviderHealth(): Promise<ProviderHealthResult> {
  const command = await claudeExecutable();
  if ((await resolveExecutablePath(command)) === null) {
    return healthResult("not_installed");
  }
  return healthResult("ready", { installedVersion: await readCliVersion(command) });
}

/** Polza has no quota windows; balance is shown by the plugin UI instead. */
export function getPolzaProviderUsage(): ProviderUsageResult {
  return { supported: false };
}

export const __testing = {
  buildProviderInstallationRun: buildClaudeProviderInstallationRun,
};

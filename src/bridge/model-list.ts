// polza: the picker list comes from the Polza catalog and the user's
// whitelist, not from the Claude CLI. The whitelist and base URL travel as
// contributed environment on the `model/list` request (`envVars`), since that
// request carries no provider options.
import { type AvailableModel } from "@get-bb/plugin-sdk/provider-bridge";
import { buildPolzaModelList } from "../polza/catalog.js";
import {
  POLZA_DEFAULT_BASE_URL,
  POLZA_ENV,
  parsePolzaModelList,
  type PolzaCatalogModel,
} from "../polza/contract.js";
import { PolzaModelStore } from "../polza/model-store.js";

export interface PolzaModelListEnv {
  baseUrl: string;
  selection: string[];
  signedIn: boolean;
}

/** Reads the contributed environment of a `model/list` or session command. */
export function readPolzaListEnv(
  envVars: Record<string, string> | undefined,
): PolzaModelListEnv {
  const baseUrl = envVars?.[POLZA_ENV.baseUrl]?.trim();
  return {
    baseUrl: baseUrl && baseUrl.length > 0 ? baseUrl : POLZA_DEFAULT_BASE_URL,
    selection: parsePolzaModelList(envVars?.[POLZA_ENV.models]),
    signedIn: envVars?.[POLZA_ENV.signedIn] === "1",
  };
}

export class PolzaEmptyModelListError extends Error {
  constructor() {
    super(
      "No Polza models are selected. Choose models in Settings → Plugins → Polza.",
    );
    this.name = "PolzaEmptyModelListError";
  }
}

export interface PolzaBridgeModelListResult {
  models: AvailableModel[];
  selectedOnlyModels: AvailableModel[];
}

const MODEL_FACTS_TTL_MS = 10 * 60_000;

/** Shared by `model/list` and the cost estimate (which reads prices with `peek`). */
export const polzaModelStore = new PolzaModelStore({ ttlMs: MODEL_FACTS_TTL_MS });

export interface PolzaModelSource {
  resolve(
    baseUrl: string,
    slugs: readonly string[],
  ): Promise<{ found: PolzaCatalogModel[]; missing: string[] }>;
}

export async function listPolzaBridgeModels(
  envVars: Record<string, string> | undefined,
  source: PolzaModelSource = polzaModelStore,
): Promise<PolzaBridgeModelListResult> {
  const env = readPolzaListEnv(envVars);
  if (env.selection.length === 0) {
    throw new PolzaEmptyModelListError();
  }
  const lookup = await source.resolve(env.baseUrl, env.selection);
  const list = buildPolzaModelList({ catalog: lookup.found, selection: env.selection });
  if (list.models.length === 0) {
    throw new Error(
      `None of the selected Polza models exist in the catalog: ${list.missing.join(", ")}.`,
    );
  }
  return { models: list.models, selectedOnlyModels: list.selectedOnlyModels };
}

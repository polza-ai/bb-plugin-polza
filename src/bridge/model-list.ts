// polza: the picker list comes from the Polza catalog and the user's
// whitelist, not from the Claude CLI. The whitelist and base URL travel as
// contributed environment on the `model/list` request (`envVars`), since that
// request carries no provider options.
import { type AvailableModel } from "@get-bb/plugin-sdk/provider-bridge";
import { createPolzaCatalogMemo, buildPolzaModelList } from "../polza/catalog.js";
import {
  POLZA_DEFAULT_BASE_URL,
  POLZA_ENV,
  parsePolzaModelList,
  type PolzaCatalogModel,
} from "../polza/contract.js";

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

const CATALOG_TTL_MS = 5 * 60_000;

export const polzaCatalogMemo = createPolzaCatalogMemo({ ttlMs: CATALOG_TTL_MS });

export async function listPolzaBridgeModels(
  envVars: Record<string, string> | undefined,
  catalog: { get(baseUrl: string): Promise<PolzaCatalogModel[]> } = polzaCatalogMemo,
): Promise<PolzaBridgeModelListResult> {
  const env = readPolzaListEnv(envVars);
  if (env.selection.length === 0) {
    throw new PolzaEmptyModelListError();
  }
  const models = await catalog.get(env.baseUrl);
  const list = buildPolzaModelList({ catalog: models, selection: env.selection });
  if (list.models.length === 0) {
    throw new Error(
      `None of the selected Polza models exist in the catalog: ${list.missing.join(", ")}.`,
    );
  }
  return { models: list.models, selectedOnlyModels: list.selectedOnlyModels };
}

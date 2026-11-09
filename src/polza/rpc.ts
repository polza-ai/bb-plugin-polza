// polza: the server ↔ frontend contract. app.tsx imports only its type.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { polzaAccountSchema } from "./account.js";
import { polzaModelListSchema } from "./contract.js";

export const polzaCatalogModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  shortDescription: z.string().nullable(),
  vendor: z.string(),
  contextLength: z.number().nullable(),
  maxCompletionTokens: z.number().nullable(),
  supportsReasoning: z.boolean(),
  reasoningEfforts: z.array(z.string()).nullable(),
  pricing: z
    .object({
      promptPerMillion: z.number(),
      completionPerMillion: z.number(),
      cacheReadPerMillion: z.number().nullable(),
      cacheWritePerMillion: z.number().nullable(),
    })
    .nullable(),
  inputModalities: z.array(z.string()),
  supportsTools: z.boolean(),
  fz152Compliant: z.boolean(),
});

export const polzaStatusSchema = z.object({
  account: polzaAccountSchema,
  models: z.array(z.string()),
  baseUrl: z.string(),
  callbackUrl: z.string(),
  dashboardUrl: z.string(),
  loginPending: z.boolean(),
});

export type PolzaStatus = z.infer<typeof polzaStatusSchema>;

export const polzaRpcContract = defineRpcContract({
  "status.get": {
    input: z.object({ refresh: z.boolean().optional() }).nullable(),
    output: polzaStatusSchema,
  },
  "login.start": {
    input: z.null(),
    output: z.object({ sessionId: z.string(), authorizeUrl: z.string() }),
  },
  "login.complete": {
    input: z.object({ pasted: z.string().min(1).max(4096) }),
    output: polzaStatusSchema,
  },
  "login.cancel": {
    input: z.null(),
    output: z.object({ cancelled: z.boolean() }),
  },
  "account.logout": {
    input: z.null(),
    output: polzaStatusSchema,
  },
  "catalog.list": {
    input: z.object({ refresh: z.boolean().optional() }).nullable(),
    output: z.object({
      models: z.array(polzaCatalogModelSchema),
      fetchedAt: z.string(),
    }),
  },
  "models.set": {
    input: z.object({ models: polzaModelListSchema }),
    output: z.object({ models: z.array(z.string()) }),
  },
});

export type PolzaRpcContract = typeof polzaRpcContract;

/** Realtime channel: any change to sign-in, key, or whitelist. */
export const POLZA_CHANGED_CHANNEL = "polza-changed";

// polza: bb's helper tasks (thread titles, commit messages) answered by a
// cheap Polza model. Registered as an AI service the user can pick in
// Settings → AI services; Automatic tries it when nothing else is ready.
import type { BbPluginApi, PluginAiServiceStatus } from "@get-bb/plugin-sdk";
import { z } from "zod";

const COMPLETE_MAX_TOKENS = 200;

const completionSchema = z
  .object({
    choices: z
      .array(
        z
          .object({
            message: z.object({ content: z.string().nullable() }).passthrough(),
          })
          .passthrough(),
      )
      .min(1),
  })
  .passthrough();

export interface PolzaAiServiceOptions {
  baseUrl: () => string;
  apiKey: () => string | null;
  model: () => string;
  enabled: () => boolean;
  fetchImpl?: typeof fetch;
}

/** One plain-text completion through Polza's OpenAI-compatible endpoint. */
export async function completeWithPolza(
  prompt: string,
  options: PolzaAiServiceOptions,
  signal: AbortSignal,
): Promise<string> {
  const key = options.apiKey();
  if (key === null) throw new Error("Sign in with Polza first");
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${options.baseUrl().replace(/\/+$/u, "")}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      model: options.model(),
      messages: [{ role: "user", content: prompt }],
      max_tokens: COMPLETE_MAX_TOKENS,
      temperature: 0.3,
      stream: false,
    }),
    signal,
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Polza answered HTTP ${response.status}${describe(body)}`);
  }
  const parsed = completionSchema.safeParse(body);
  const text = parsed.success ? (parsed.data.choices[0]?.message.content ?? "") : "";
  if (text.trim().length === 0) throw new Error("Polza returned an empty completion");
  return text.trim();
}

export function registerPolzaAiService(bb: BbPluginApi, options: PolzaAiServiceOptions): void {
  bb.experimental_aiServices.register({
    id: "polza",
    displayName: "Polza",
    complete: (prompt, { signal }) => completeWithPolza(prompt, options, signal),
    async status(): Promise<PluginAiServiceStatus> {
      if (!options.enabled()) {
        return { ready: false, message: "Turned off in the Polza plugin settings" };
      }
      if (options.apiKey() === null) {
        return { ready: false, message: "Sign in with Polza in Settings → Plugins → Polza" };
      }
      return { ready: true };
    },
  });
}

function describe(body: unknown): string {
  if (body && typeof body === "object") {
    const error = (body as Record<string, unknown>)["error"];
    if (error && typeof error === "object") {
      const message = (error as Record<string, unknown>)["message"];
      if (typeof message === "string") return `: ${message}`;
    }
  }
  return "";
}

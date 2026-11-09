// polza: the forked Claude Code tests start sessions without provider
// options. The Polza bridge refuses a session without a key, so the tests
// drive it through this wrapper, which adds a test key to every session
// request before the bridge sees it.
export const POLZA_TEST_KEY = "pza_test_key";

const SESSION_METHODS = new Set([
  "thread/start",
  "thread/resume",
  "thread/fork",
  "turn/start",
  "turn/steer",
]);

export function withPolzaTestKey(
  handleLine: (line: string) => void,
): (line: string) => void {
  return (line) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      handleLine(line);
      return;
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      SESSION_METHODS.has(String((parsed as { method?: unknown }).method)) &&
      typeof (parsed as { params?: unknown }).params === "object"
    ) {
      const params = (parsed as { params: Record<string, unknown> }).params;
      const options = (params["options"] ?? {}) as Record<string, unknown>;
      const providerOptions = (options["providerOptions"] ?? {}) as Record<string, unknown>;
      if (providerOptions["polzaApiKey"] === undefined) {
        params["options"] = {
          ...options,
          providerOptions: { ...providerOptions, polzaApiKey: POLZA_TEST_KEY },
        };
        handleLine(JSON.stringify(parsed));
        return;
      }
    }
    handleLine(line);
  };
}

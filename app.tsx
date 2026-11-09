// bb-plugin-polza — frontend entry (interpreted by the bb app).
//
// Three surfaces: the settings page (sign in, account, picker models), a
// sidebar footer disclosure with the balance, and a card above a Polza
// thread's composer with the estimated ruble spend.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import {
  definePluginApp,
  experimental_useThreadExtensionState as useThreadExtensionState,
  type ExperimentalThreadContextSegmentProps,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { polzaRpcContract } from "./server";
import type { PolzaStatus } from "./src/polza/rpc";
import {
  POLZA_COST_STATE_NAME,
  POLZA_PROVIDER_ID,
  formatRub,
  polzaCostStateSchema,
} from "./src/polza/contract";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Rpc = ReturnType<typeof useRpc<typeof polzaRpcContract>>;
type CatalogModel = Awaited<ReturnType<Rpc["call"]>> extends infer R
  ? R extends { models: (infer M)[]; fetchedAt: string }
    ? M
    : never
  : never;

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function useStatus() {
  const rpc = useRpc<typeof polzaRpcContract>();
  const [status, setStatus] = useState<PolzaStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(
    (refresh = false) =>
      rpc.call("status.get", { refresh }).then(
        (next) => {
          setStatus(next);
          setError(null);
        },
        (cause: unknown) => setError(describeError(cause)),
      ),
    [rpc],
  );
  useEffect(() => {
    void refetch();
  }, [refetch]);
  useRealtime("polza-changed", () => void refetch(true));
  return { rpc, status, error, refetch, setStatus };
}

// ---------------------------------------------------------------------------
// Settings page
// ---------------------------------------------------------------------------

function SignInBlock({
  status,
  rpc,
  onChanged,
}: {
  status: PolzaStatus;
  rpc: Rpc;
  onChanged: (next: PolzaStatus) => void;
}) {
  const navigate = useBbNavigate();
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const started = await rpc.call("login.start");
      setAuthorizeUrl(started.authorizeUrl);
      navigate.openUrl(started.authorizeUrl);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  };
  const complete = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pasted.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      onChanged(await rpc.call("login.complete", { pasted: pasted.trim() }));
      setPasted("");
      setAuthorizeUrl(null);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    await rpc.call("login.cancel").catch(() => undefined);
    setAuthorizeUrl(null);
  };

  const pending = status.loginPending || authorizeUrl !== null;
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h3 className="text-sm font-medium">Sign in with Polza</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        A browser tab opens the Polza consent page. Pick the organisation that
        pays and a spend limit for the key (Polza suggests 100 ₽ per day; raise
        it for agent work). The key is stored on the bb server only.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button onClick={start} disabled={busy}>
          <Icon name="polza/mark" className="size-4" />
          {pending ? "Open the consent page again" : "Sign in with Polza"}
        </Button>
        {pending ? (
          <Button variant="ghost" onClick={cancel} disabled={busy}>
            Cancel
          </Button>
        ) : null}
      </div>
      {pending ? (
        <form onSubmit={complete} className="mt-4 space-y-2">
          <p className="text-xs text-muted-foreground">
            If the browser could not reach this bb server after consent, copy the
            address it tried to open (or just the <code>code</code> value) and
            paste it here.
          </p>
          <div className="flex items-center gap-2">
            <Input
              value={pasted}
              onChange={(event) => setPasted(event.target.value)}
              placeholder="http://127.0.0.1:…/oauth/callback?code=…"
              aria-label="Callback address or code"
            />
            <Button type="submit" variant="secondary" disabled={busy || pasted.trim() === ""}>
              Finish
            </Button>
          </div>
        </form>
      ) : null}
      {error === null ? null : (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="min-w-[9rem] flex-1 rounded-md border border-border px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-base font-medium tabular-nums">{value}</div>
      {note ? <div className="text-xs text-muted-foreground">{note}</div> : null}
    </div>
  );
}

function resetLabel(reset: string | null): string {
  switch (reset) {
    case "daily":
      return "resets daily";
    case "weekly":
      return "resets weekly";
    case "monthly":
      return "resets monthly";
    case "never":
    case null:
      return "no reset";
    default:
      return reset;
  }
}

function AccountBlock({
  status,
  rpc,
  onChanged,
  onRefresh,
}: {
  status: PolzaStatus;
  rpc: Rpc;
  onChanged: (next: PolzaStatus) => void;
  onRefresh: () => void;
}) {
  const navigate = useBbNavigate();
  const [busy, setBusy] = useState(false);
  const { account } = status;
  const who = account.user?.email ?? account.user?.name ?? "Polza account";
  const logout = async () => {
    setBusy(true);
    try {
      onChanged(await rpc.call("account.logout"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium">{who}</h3>
          <p className="text-xs text-muted-foreground">
            {account.keyLabel ? `Key ${account.keyLabel}` : "Signed in"} · {status.baseUrl}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => navigate.openUrl(status.dashboardUrl)}>
            <Icon name="ExternalLink" className="size-4" />
            Top up
          </Button>
          <Button variant="ghost" size="sm" onClick={onRefresh} aria-label="Refresh balance">
            <Icon name="RotateCcw" className="size-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={logout} disabled={busy}>
            Sign out
          </Button>
        </div>
      </div>
      {account.keyRevoked ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          Polza refused this key. Sign out and sign in again.
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <Stat
          label="Available balance"
          value={account.balance?.available === null || account.balance === null ? "—" : formatRub(account.balance.available)}
          note={
            account.balance?.amount !== null && account.balance?.amount !== undefined
              ? `wallet ${formatRub(account.balance.amount)}`
              : undefined
          }
        />
        <Stat
          label="Key limit left"
          value={
            account.keyLimit === null || account.keyLimit.limit === null
              ? "no limit"
              : formatRub(account.keyLimit.remaining ?? 0)
          }
          note={
            account.keyLimit === null || account.keyLimit.limit === null
              ? undefined
              : `of ${formatRub(account.keyLimit.limit)}, ${resetLabel(account.keyLimit.reset)}`
          }
        />
        <Stat
          label="Spent by this key"
          value={account.keyLimit?.usageTotal == null ? "—" : formatRub(account.keyLimit.usageTotal)}
          note={
            account.keyLimit?.usageDaily == null ? undefined : `today ${formatRub(account.keyLimit.usageDaily)}`
          }
        />
      </div>
      {account.error ? (
        <p className="mt-2 text-xs text-muted-foreground">Last lookup: {account.error}</p>
      ) : null}
    </div>
  );
}

function priceLabel(model: CatalogModel): string {
  if (model.pricing === null) return "no price";
  return `${formatRub(model.pricing.promptPerMillion)} / ${formatRub(model.pricing.completionPerMillion)} per Mtok`;
}

function useCatalog(rpc: Rpc) {
  const [catalog, setCatalog] = useState<CatalogModel[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  useEffect(() => {
    rpc.call("catalog.list", null).then(
      (result) => {
        setCatalog(result.models);
        setCatalogError(null);
      },
      (cause: unknown) => setCatalogError(describeError(cause)),
    );
  }, [rpc]);
  return { catalog, catalogError };
}

function ModelsBlock({
  status,
  rpc,
  catalog,
  catalogError,
  onSaved,
}: {
  status: PolzaStatus;
  rpc: Rpc;
  catalog: CatalogModel[] | null;
  catalogError: string | null;
  onSaved: () => void;
}) {
  const [query, setQuery] = useState("");
  const [vendor, setVendor] = useState<string>("all");
  const [selection, setSelection] = useState<string[]>(status.models);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    setSelection(status.models);
  }, [status.models]);

  const byId = useMemo(() => new Map((catalog ?? []).map((model) => [model.id, model])), [catalog]);
  const vendors = useMemo(
    () => [...new Set((catalog ?? []).map((model) => model.vendor))].sort(),
    [catalog],
  );
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (catalog ?? [])
      .filter((model) => vendor === "all" || model.vendor === vendor)
      .filter(
        (model) =>
          needle === "" ||
          model.id.toLowerCase().includes(needle) ||
          model.name.toLowerCase().includes(needle),
      )
      .slice(0, 80);
  }, [catalog, query, vendor]);

  const dirty = JSON.stringify(selection) !== JSON.stringify(status.models);
  const toggle = (id: string, on: boolean) =>
    setSelection((current) => (on ? [...current.filter((entry) => entry !== id), id] : current.filter((entry) => entry !== id)));
  const move = (id: string, delta: number) =>
    setSelection((current) => {
      const index = current.indexOf(id);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = [...current];
      next.splice(index, 1);
      next.splice(target, 0, id);
      return next;
    });
  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await rpc.call("models.set", { models: selection });
      onSaved();
    } catch (cause) {
      setSaveError(describeError(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium">Models in the picker</h3>
          <p className="text-xs text-muted-foreground">
            The first model is the default for new threads. Prices are rubles per million tokens, input / output.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {dirty ? (
            <Button variant="ghost" size="sm" onClick={() => setSelection(status.models)} disabled={saving}>
              Discard
            </Button>
          ) : null}
          <Button size="sm" onClick={save} disabled={!dirty || saving || selection.length === 0}>
            Save {selection.length > 0 ? `(${selection.length})` : ""}
          </Button>
        </div>
      </div>
      {saveError ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {saveError}
        </p>
      ) : null}

      {selection.length === 0 ? (
        <p className="mt-3 rounded-md border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground">
          No models selected: the Polza provider offers nothing until you pick some below.
        </p>
      ) : (
        <ol className="mt-3 divide-y divide-border overflow-hidden rounded-md border border-border">
          {selection.map((id, index) => {
            const model = byId.get(id);
            return (
              <li key={id} className="flex items-center gap-2 px-3 py-2 text-sm">
                <span className="w-5 text-xs text-muted-foreground tabular-nums">{index + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{model?.name ?? id}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {id}
                    {model ? ` · ${priceLabel(model)}` : catalog ? " · not in the catalog" : ""}
                  </span>
                </span>
                <Button variant="ghost" size="icon" className="size-7" aria-label="Move up" disabled={index === 0} onClick={() => move(id, -1)}>
                  <Icon name="ChevronUp" className="size-4" />
                </Button>
                <Button variant="ghost" size="icon" className="size-7" aria-label="Move down" disabled={index === selection.length - 1} onClick={() => move(id, 1)}>
                  <Icon name="ChevronDown" className="size-4" />
                </Button>
                <Button variant="ghost" size="icon" className="size-7 text-muted-foreground" aria-label={`Remove ${id}`} onClick={() => toggle(id, false)}>
                  <Icon name="X" className="size-4" />
                </Button>
              </li>
            );
          })}
        </ol>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search the Polza catalog"
          aria-label="Search models"
          className="max-w-xs"
        />
        <select
          value={vendor}
          onChange={(event) => setVendor(event.target.value)}
          aria-label="Vendor"
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
        >
          <option value="all">All vendors</option>
          {vendors.map((entry) => (
            <option key={entry} value={entry}>
              {entry}
            </option>
          ))}
        </select>
        <span className="text-xs text-muted-foreground">
          {catalog === null ? "Loading catalog…" : `${catalog.length} chat models`}
        </span>
      </div>
      {catalogError ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {catalogError}
        </p>
      ) : null}
      {catalog !== null ? (
        <ul className="mt-2 max-h-80 divide-y divide-border overflow-y-auto rounded-md border border-border">
          {filtered.map((model) => {
            const checked = selection.includes(model.id);
            return (
              <li key={model.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <Checkbox
                  checked={checked}
                  onCheckedChange={(value) => toggle(model.id, value === true)}
                  aria-label={`Offer ${model.id}`}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">
                    {model.name}
                    {model.supportsReasoning ? (
                      <span className="ml-2 rounded bg-muted px-1 text-[10px] uppercase text-muted-foreground">reasoning</span>
                    ) : null}
                    {!model.supportsTools ? (
                      <span className="ml-2 rounded bg-muted px-1 text-[10px] uppercase text-muted-foreground">no tools</span>
                    ) : null}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {model.id} · {priceLabel(model)}
                    {model.contextLength ? ` · ${Math.round(model.contextLength / 1000)}K` : ""}
                  </span>
                </span>
              </li>
            );
          })}
          {filtered.length === 0 ? (
            <li className="px-3 py-4 text-center text-sm text-muted-foreground">Nothing matches.</li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

function AiServiceBlock({
  status,
  rpc,
  catalog,
  onSaved,
}: {
  status: PolzaStatus;
  rpc: Rpc;
  catalog: CatalogModel[] | null;
  onSaved: () => void;
}) {
  const [model, setModel] = useState(status.aiService.model);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setModel(status.aiService.model);
  }, [status.aiService.model]);
  const cheap = useMemo(
    () =>
      (catalog ?? [])
        .filter((entry) => entry.pricing !== null && entry.supportsTools)
        .sort((a, b) => (a.pricing!.completionPerMillion) - (b.pricing!.completionPerMillion))
        .slice(0, 40),
    [catalog],
  );
  const save = async (patch: { enabled?: boolean; model?: string }) => {
    setBusy(true);
    setError(null);
    try {
      await rpc.call("aiService.set", patch);
      onSaved();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  };
  const current = catalog?.find((entry) => entry.id === model) ?? null;
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">Thread titles and commit messages</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            bb asks an AI service for a short thread title after the first prompt and for commit messages. Polza can be that service; pick it or leave Automatic in Settings → AI services. A title costs a fraction of a kopeck on a small model.
          </p>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-sm">
          <Checkbox
            checked={status.aiService.enabled}
            disabled={busy}
            onCheckedChange={(value) => void save({ enabled: value === true })}
            aria-label="Offer Polza as an AI service"
          />
          Offer Polza
        </label>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Input
          list="polza-ai-service-models"
          value={model}
          onChange={(event) => setModel(event.target.value)}
          placeholder="vendor/model"
          aria-label="Model for titles and commit messages"
          className="max-w-sm font-mono text-xs"
        />
        <datalist id="polza-ai-service-models">
          {cheap.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {`${entry.name} · ${priceLabel(entry)}`}
            </option>
          ))}
        </datalist>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy || model.trim() === status.aiService.model || model.trim() === ""}
          onClick={() => void save({ model: model.trim() })}
        >
          Save model
        </Button>
        <span className="text-xs text-muted-foreground">
          {current ? `${current.name} · ${priceLabel(current)}` : catalog ? "Not in the catalog" : ""}
        </span>
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function PolzaSettings() {
  const { rpc, status, error, refetch, setStatus } = useStatus();
  const { catalog, catalogError } = useCatalog(rpc);
  if (status === null) {
    return (
      <p className="text-sm text-muted-foreground">{error ?? "Loading Polza status…"}</p>
    );
  }
  return (
    <div className="space-y-4">
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {status.account.signedIn ? (
        <AccountBlock status={status} rpc={rpc} onChanged={setStatus} onRefresh={() => void refetch(true)} />
      ) : (
        <SignInBlock status={status} rpc={rpc} onChanged={setStatus} />
      )}
      <ModelsBlock status={status} rpc={rpc} catalog={catalog} catalogError={catalogError} onSaved={() => void refetch()} />
      <AiServiceBlock status={status} rpc={rpc} catalog={catalog} onSaved={() => void refetch()} />
      <p className="text-xs text-muted-foreground">
        Threads run Claude Code against {status.baseUrl}. Install or update the Claude CLI from Settings → Providers → Polza.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar footer: balance at a glance
// ---------------------------------------------------------------------------

function BalanceRow({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right tabular-nums">
        {value}
        {note ? <span className="ml-1 text-muted-foreground">{note}</span> : null}
      </span>
    </div>
  );
}

function BalanceDisclosure({ dismiss }: { dismiss(): void }) {
  const { status, error, refetch } = useStatus();
  const navigate = useBbNavigate();
  const account = status?.account;
  const iconButton =
    "flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground";
  return (
    <div className="flex w-full min-w-0 flex-col text-xs">
      <div className="flex items-center gap-1 px-2.5 pt-2">
        <Icon name="polza/mark" className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate font-medium">Polza</span>
        <button type="button" aria-label="Refresh Polza balance" className={iconButton} onClick={() => void refetch(true)}>
          <Icon name="RotateCcw" className="size-3.5" aria-hidden="true" />
        </button>
        <button type="button" aria-label="Collapse Polza balance" className={iconButton} onClick={dismiss}>
          <Icon name="ChevronDown" className="size-4" aria-hidden="true" />
        </button>
      </div>
      <div className="space-y-1.5 px-2.5 pb-2.5 pt-2">
        {status === null ? (
          <p className="text-muted-foreground">{error ?? "Loading…"}</p>
        ) : !account?.signedIn ? (
          <p className="text-muted-foreground">Not signed in. Open Settings → Plugins → Polza.</p>
        ) : (
          <>
            <BalanceRow
              label="Available"
              value={account.balance?.available == null ? "—" : formatRub(account.balance.available)}
            />
            {account.balance?.amount != null && account.balance.available !== account.balance.amount ? (
              <BalanceRow label="Wallet" value={formatRub(account.balance.amount)} />
            ) : null}
            <BalanceRow
              label="Key limit"
              value={
                account.keyLimit === null || account.keyLimit.limit === null
                  ? "none"
                  : `${formatRub(account.keyLimit.remaining ?? 0)} of ${formatRub(account.keyLimit.limit)}`
              }
              note={account.keyLimit?.limit != null ? resetLabel(account.keyLimit.reset) : undefined}
            />
            {account.keyLimit?.usageDaily != null ? (
              <BalanceRow label="Spent today" value={formatRub(account.keyLimit.usageDaily)} />
            ) : null}
            {account.keyRevoked ? <p className="text-destructive">Key refused: sign in again.</p> : null}
            <button
              type="button"
              className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-sidebar-accent"
              onClick={() => navigate.openUrl(status.dashboardUrl)}
            >
              <Icon name="ExternalLink" className="size-3.5" aria-hidden="true" />
              Top up on polza.ai
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Context row above the composer: estimated spend of the open thread
// ---------------------------------------------------------------------------

function useCost(threadId: string) {
  const parsed = polzaCostStateSchema.safeParse(useThreadExtensionState(threadId, POLZA_COST_STATE_NAME));
  return parsed.success ? parsed.data : null;
}

/** Share of prompt tokens served from the prompt cache, 0–100, or null before any input. */
function cacheHitPercent(tokens: { input: number; cacheRead: number; cacheWrite: number }): number | null {
  const prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  return prompt === 0 ? null : Math.round((tokens.cacheRead / prompt) * 100);
}

function fmtInt(value: number): string {
  return value.toLocaleString("ru-RU");
}

function useCostSegmentVisible({ threadId }: { threadId: string }): boolean {
  return useCost(threadId) !== null;
}

function CostSegmentSummary({ threadId, isExpanded, onToggle }: ExperimentalThreadContextSegmentProps) {
  const cost = useCost(threadId);
  if (cost === null) return null;
  const hit = cacheHitPercent(cost.tokens);
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={isExpanded}
      aria-label={`Polza spend ≈ ${formatRub(cost.rub)}${hit === null ? "" : `, cache hit ${hit}%`}`}
      className={cn(
        "flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground",
        "hover:bg-muted hover:text-foreground",
        isExpanded && "bg-muted text-foreground",
      )}
    >
      <Icon name="polza/mark" className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate tabular-nums">
        ≈ {formatRub(cost.rub)}
        {hit === null ? null : <span className="opacity-70"> · cache {hit}%</span>}
        {cost.unpriced ? <span className="opacity-70"> · partly unpriced</span> : null}
      </span>
    </button>
  );
}

function CostSegmentDetails({ threadId, isExpanded }: ExperimentalThreadContextSegmentProps) {
  const cost = useCost(threadId);
  if (cost === null || !isExpanded) return null;
  const hit = cacheHitPercent(cost.tokens);
  const rows: [string, string][] = [
    ["Spend, this session", `≈ ${formatRub(cost.rub)}`],
    ["Last turn", formatRub(cost.lastTurnRub)],
    ["Cache hit", hit === null ? "—" : `${hit}%`],
    ["Input tokens", fmtInt(cost.tokens.input)],
    ["Cache read / write", `${fmtInt(cost.tokens.cacheRead)} / ${fmtInt(cost.tokens.cacheWrite)}`],
    ["Output tokens", fmtInt(cost.tokens.output)],
    ["Model", cost.model ?? "—"],
  ];
  return (
    <div className="px-3 pb-2 pt-1 text-xs">
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 sm:grid-cols-[auto_1fr_auto_1fr]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="truncate text-right tabular-nums sm:text-left">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-muted-foreground">
        Estimated from token counts and catalog prices{cost.unpriced ? "; a model without a catalog price was not counted" : ""}. The Polza dashboard shows the billed amount.
      </p>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "polza",
    title: "Polza account and models",
    description: "Sign in with Polza, watch the balance and choose which catalog models the picker offers.",
    component: PolzaSettings,
  });
  app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: "balance",
    label: "Polza balance",
    icon: "polza/mark",
    component: BalanceDisclosure,
  });
  app.slots.experimental_threadContextSegment({
    id: "cost",
    title: "Polza spend",
    group: "2_polza",
    summary: CostSegmentSummary,
    details: CostSegmentDetails,
    useVisible: useCostSegmentVisible,
  });
  app.slots.experimental_providerIcon({
    providerKind: "agent",
    providerId: POLZA_PROVIDER_ID,
    icon: ({ className }: { className?: string }) => (
      <svg viewBox="0 0 36 36" fill="currentColor" className={className} aria-hidden="true">
        <path d="M14.4659 0C13.629 0 12.9506 0.678407 12.9506 1.51526V5.81199C12.9506 6.22638 13.1203 6.62269 13.4202 6.90865L16.9545 10.2784C17.5398 10.8365 18.4601 10.8366 19.0455 10.2786L22.5813 6.90868C22.589 6.90137 22.5966 6.89398 22.6041 6.88652C22.8899 6.60242 23.0512 6.21571 23.0512 5.81181V5.80639V1.51526C23.0512 0.678406 22.3728 0 21.5359 0H14.4659Z" />
        <path d="M2.77355 7.77176C2.18189 8.36342 2.18179 9.32265 2.77333 9.91444L5.80944 12.9518C6.10244 13.245 6.50273 13.4053 6.91707 13.3955L11.8006 13.2795C12.6093 13.2603 13.2603 12.6093 13.2795 11.8007L13.3954 6.91709C13.4053 6.50274 13.245 6.10245 12.9518 5.80944L9.91444 2.77333C9.32266 2.18179 8.36343 2.1819 7.77177 2.77355L2.77355 7.77176Z" />
        <path d="M0 21.5359C0 22.3728 0.678406 23.0512 1.51526 23.0512H5.81182C6.22631 23.0512 6.62271 22.8814 6.90868 22.5813L10.2786 19.0456C10.8366 18.4602 10.8365 17.5398 10.2784 16.9545L6.90865 13.4203C6.62269 13.1203 6.22638 12.9506 5.81199 12.9506H1.51526C0.678405 12.9506 0 13.629 0 14.4659V21.5359Z" />
        <path d="M7.77154 33.2279C8.36327 33.8197 9.32279 33.8198 9.91459 33.228L12.9521 30.1905C13.2451 29.8975 13.4053 29.4973 13.3954 29.0831L13.2795 24.1993C13.2603 23.3907 12.6093 22.7397 11.8006 22.7205L6.91708 22.6045C6.50273 22.5947 6.10244 22.755 5.80944 23.0482L2.77318 26.0857C2.1817 26.6774 2.18174 27.6366 2.77327 28.2282L7.77154 33.2279Z" />
        <path d="M21.5359 36C22.3728 36 23.0512 35.3216 23.0512 34.4847V30.1882C23.0512 29.7737 22.8814 29.3773 22.5813 29.0913L19.0455 25.7213C18.4601 25.1634 17.5398 25.1635 16.9545 25.7215L13.4202 29.0914C13.1203 29.3773 12.9506 29.7736 12.9506 30.188V34.4847C12.9506 35.3216 13.629 36 14.4659 36H21.5359Z" />
        <path d="M33.2281 28.2285C33.8199 27.6367 33.8199 26.6773 33.2281 26.0856L30.1905 23.0479C29.8975 22.7549 29.4973 22.5947 29.0831 22.6045L24.1993 22.7205C23.3906 22.7397 22.7396 23.3907 22.7204 24.1993L22.6045 29.0831C22.5947 29.4973 22.7549 29.8975 23.0479 30.1905L26.0855 33.2281C26.6773 33.8199 27.6367 33.8199 28.2284 33.2281L33.2281 28.2285Z" />
        <path d="M36 14.4659C36 13.629 35.3216 12.9506 34.4847 12.9506H30.1919H30.188C29.7849 12.9506 29.399 13.1112 29.1151 13.3959C29.1071 13.4039 29.0991 13.412 29.0913 13.4203L25.7215 16.9545C25.1635 17.5398 25.1634 18.4602 25.7213 19.0456L29.0913 22.5813C29.3773 22.8814 29.7736 23.0512 30.1881 23.0512H34.4847C35.3216 23.0512 36 22.3728 36 21.5359V14.4659Z" />
        <path d="M13.4354 18.0064C13.4354 15.4819 15.4819 13.4354 18.0064 13.4354C20.5309 13.4354 22.5775 15.4819 22.5775 18.0064C22.5775 20.531 20.5309 22.5775 18.0064 22.5775C15.4819 22.5775 13.4354 20.531 13.4354 18.0064Z" />
        <path d="M23.0512 5.80639V5.81181C23.0512 6.21571 22.8899 6.60242 22.6041 6.88652C22.6041 6.8967 22.6043 6.90689 22.6045 6.91709L22.7204 11.8007C22.7396 12.6093 23.3906 13.2603 24.1993 13.2795L29.0831 13.3955C29.0938 13.3957 29.1044 13.3959 29.1151 13.3959C29.399 13.1112 29.7849 12.9506 30.188 12.9506H30.1919L33.228 9.91458C33.8198 9.32278 33.8197 8.36325 33.2278 7.77153L28.2282 2.77326C27.6365 2.18174 26.6774 2.18171 26.0857 2.77318L23.0512 5.80639Z" />
      </svg>
    ),
  });
});

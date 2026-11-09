// bb-plugin-polza — frontend entry (interpreted by the bb app).
//
// Three surfaces: the settings page (sign in, account, picker models), a
// sidebar footer disclosure with the balance, and a card above a Polza
// thread's composer with the estimated ruble spend.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import {
  definePluginApp,
  experimental_CollapsibleStackCard as CollapsibleStackCard,
  experimental_useThreadExtensionState as useThreadExtensionState,
  useBbNavigate,
  useComposer,
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
          <Icon name="LogIn" className="size-4" />
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
            <Icon name="RefreshCw" className="size-4" />
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

function ModelsBlock({
  status,
  rpc,
  onSaved,
}: {
  status: PolzaStatus;
  rpc: Rpc;
  onSaved: () => void;
}) {
  const [catalog, setCatalog] = useState<CatalogModel[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [vendor, setVendor] = useState<string>("all");
  const [selection, setSelection] = useState<string[]>(status.models);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    setSelection(status.models);
  }, [status.models]);
  useEffect(() => {
    rpc.call("catalog.list", null).then(
      (result) => {
        setCatalog(result.models);
        setCatalogError(null);
      },
      (cause: unknown) => setCatalogError(describeError(cause)),
    );
  }, [rpc]);

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

function PolzaSettings() {
  const { rpc, status, error, refetch, setStatus } = useStatus();
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
      <ModelsBlock status={status} rpc={rpc} onSaved={() => void refetch()} />
      <p className="text-xs text-muted-foreground">
        Threads run Claude Code against {status.baseUrl}. Install or update the Claude CLI from Settings → Providers → Polza.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar footer: balance at a glance
// ---------------------------------------------------------------------------

function BalanceDisclosure({ dismiss }: { dismiss(): void }) {
  const { status, error, refetch } = useStatus();
  const navigate = useBbNavigate();
  const account = status?.account;
  return (
    <div className="w-72 max-w-full space-y-3 p-3 text-sm">
      <div className="flex items-center justify-between">
        <span className="font-medium">Polza</span>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="size-7" aria-label="Refresh" onClick={() => void refetch(true)}>
            <Icon name="RefreshCw" className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" className="size-7" aria-label="Close" onClick={dismiss}>
            <Icon name="X" className="size-4" />
          </Button>
        </div>
      </div>
      {status === null ? (
        <p className="text-muted-foreground">{error ?? "Loading…"}</p>
      ) : !account?.signedIn ? (
        <p className="text-muted-foreground">Not signed in. Open Settings → Plugins → Polza.</p>
      ) : (
        <>
          <div className="flex gap-2">
            <Stat
              label="Available"
              value={account.balance?.available == null ? "—" : formatRub(account.balance.available)}
            />
            <Stat
              label="Key limit"
              value={
                account.keyLimit === null || account.keyLimit.limit === null
                  ? "none"
                  : formatRub(account.keyLimit.remaining ?? 0)
              }
              note={account.keyLimit?.limit != null ? resetLabel(account.keyLimit.reset) : undefined}
            />
          </div>
          {account.keyRevoked ? (
            <p className="text-destructive">Key refused: sign in again.</p>
          ) : null}
          <Button variant="secondary" size="sm" className="w-full" onClick={() => navigate.openUrl(status.dashboardUrl)}>
            <Icon name="ExternalLink" className="size-4" />
            Polza dashboard
          </Button>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Composer card: estimated spend of the open thread
// ---------------------------------------------------------------------------

function CostBanner() {
  const { scope } = useComposer();
  return scope.kind === "thread" ? <CostCard threadId={scope.threadId} /> : null;
}

function CostCard({ threadId }: { threadId: string }) {
  const parsed = polzaCostStateSchema.safeParse(useThreadExtensionState(threadId, POLZA_COST_STATE_NAME));
  if (!parsed.success) return null;
  const cost = parsed.data;
  const tokens = cost.tokens;
  return (
    <CollapsibleStackCard
      label="Polza spend"
      title={`Polza: ≈ ${formatRub(cost.rub)}${cost.unpriced ? " (partly unpriced)" : ""}`}
      icon="Wallet"
      isActive={false}
    >
      <div className={cn("grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground")}>
        <span>Last turn</span>
        <span className="text-right tabular-nums">{formatRub(cost.lastTurnRub)}</span>
        <span>Input tokens</span>
        <span className="text-right tabular-nums">{tokens.input.toLocaleString("ru-RU")}</span>
        <span>Cache read / write</span>
        <span className="text-right tabular-nums">
          {tokens.cacheRead.toLocaleString("ru-RU")} / {tokens.cacheWrite.toLocaleString("ru-RU")}
        </span>
        <span>Output tokens</span>
        <span className="text-right tabular-nums">{tokens.output.toLocaleString("ru-RU")}</span>
        <span>Model</span>
        <span className="truncate text-right">{cost.model ?? "—"}</span>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Estimate from token counts and catalog prices for this bridge session; the Polza dashboard has the billed amount.
      </p>
    </CollapsibleStackCard>
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
    icon: "Wallet",
    component: BalanceDisclosure,
  });
  app.composer.customize({
    id: "cost",
    scopes: ["thread"],
    banners: [{ id: "cost", chrome: "bare", component: CostBanner }],
  });
  app.slots.experimental_providerIcon({
    providerKind: "agent",
    providerId: POLZA_PROVIDER_ID,
    icon: ({ className }: { className?: string }) => (
      <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
        <path d="M5 3h8.5a6 6 0 0 1 0 12H9v6H5V3zm4 3.6v4.8h4.3a2.4 2.4 0 0 0 0-4.8H9z" />
        <circle cx="17.5" cy="18.5" r="2.5" />
      </svg>
    ),
  });
});

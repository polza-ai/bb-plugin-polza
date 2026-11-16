// polza: decides when the user should hear that Polza money is running out.
import type { PolzaAccount } from "./account.js";

export type PolzaBalanceAlertKind = "balance" | "key-limit";

export interface PolzaBalanceAlert {
  kind: PolzaBalanceAlertKind;
  title: string;
  body: string;
}

/** The key limit alerts when under a tenth of it is left. */
const KEY_LIMIT_SHARE = 0.1;
/** An alert repeats only after the figure recovered above the line by this factor. */
const RECOVERY_FACTOR = 1.2;

const rub = (value: number): string =>
  `${value.toLocaleString("ru-RU", { maximumFractionDigits: value < 100 ? 2 : 0 })} ₽`;

function resetWord(reset: string | null): string {
  if (reset === "daily") return "resets tomorrow";
  if (reset === "weekly") return "resets next week";
  if (reset === "monthly") return "resets next month";
  return "does not reset";
}

/**
 * Remembers which alerts are active, so each is sent once per dip: a balance
 * that stays low does not notify on every check, and a top-up re-arms it.
 */
export class PolzaBalanceWatch {
  private readonly active = new Set<PolzaBalanceAlertKind>();

  constructor(initiallyActive: readonly PolzaBalanceAlertKind[] = []) {
    for (const kind of initiallyActive) this.active.add(kind);
  }

  activeKinds(): PolzaBalanceAlertKind[] {
    return [...this.active];
  }

  /** Alerts to send now for this account reading; `thresholdRub <= 0` turns the watch off. */
  check(account: PolzaAccount, thresholdRub: number): PolzaBalanceAlert[] {
    if (!account.signedIn || thresholdRub <= 0) {
      this.active.clear();
      return [];
    }
    const alerts: PolzaBalanceAlert[] = [];
    // The wallet, not `available`: that one is capped by the key limit, which
    // has its own alert below.
    const available = account.balance?.amount ?? account.balance?.available ?? null;
    if (available !== null) {
      if (available < thresholdRub) {
        if (!this.active.has("balance")) {
          this.active.add("balance");
          alerts.push({
            kind: "balance",
            title: `Polza: ${rub(Math.max(0, available))} left`,
            body: `The balance is under ${rub(thresholdRub)}. Top up at polza.ai so threads do not stop.`,
          });
        }
      } else if (available >= thresholdRub * RECOVERY_FACTOR) {
        this.active.delete("balance");
      }
    }
    const limit = account.keyLimit?.limit ?? null;
    const remaining = account.keyLimit?.remaining ?? null;
    if (limit !== null && limit > 0 && remaining !== null) {
      const line = limit * KEY_LIMIT_SHARE;
      if (remaining < line) {
        if (!this.active.has("key-limit")) {
          this.active.add("key-limit");
          alerts.push({
            kind: "key-limit",
            title: `Polza key limit: ${rub(Math.max(0, remaining))} of ${rub(limit)} left`,
            body: `The limit ${resetWord(account.keyLimit?.reset ?? null)}. Raise it in the Polza dashboard if threads must keep running.`,
          });
        }
      } else if (remaining >= line * RECOVERY_FACTOR) {
        this.active.delete("key-limit");
      }
    }
    return alerts;
  }
}

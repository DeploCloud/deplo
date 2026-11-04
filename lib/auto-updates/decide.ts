import type { UpdateLogEntry } from "../data/update-log";
import { versionTag } from "../version";
import { currentSlot, describeAt, nextSlotAt, windowEndAfter } from "./window";

export const SOAK_MS = 24 * 3_600_000;
export const MAX_FAILED_NIGHTS = 3;

export interface AutoUpdateInput {
  now: Date;
  hour: number;
  timezone: string;
  active: boolean;
  postponedUntil: string | null;
  next: string | null;
  nextPublishedAt: string | null;
  securityFix: boolean;
  manualUpdate: string | null;
  // The automatic rows of the update log, any order.
  log: UpdateLogEntry[];
  busy: string | null;
}

export type AutoUpdateStep =
  | { kind: "wait" }
  | { kind: "skip"; version: string; reason: string }
  | { kind: "hold"; version: string; reason: string }
  | { kind: "install"; version: string };

const WAIT: AutoUpdateStep = { kind: "wait" };

const FAILED = new Set(["failed", "rolled_back"]);

/** One tick's answer: nothing, a row for the log, or the update to start. */
export function decideAutoUpdate(i: AutoUpdateInput): AutoUpdateStep {
  if (!i.active || !i.next) return WAIT;
  const slot = currentSlot(i.now, i.hour, i.timezone);
  if (!slot) return WAIT;
  const version = versionTag(i.next);
  const since = (at: Date) => (e: UpdateLogEntry) =>
    Date.parse(e.at) >= at.getTime();
  // One answer per slot, never over an update still under way.
  if (i.log.some((e) => e.outcome === "running" || since(slot.start)(e)))
    return WAIT;
  const mine = i.log.filter((e) => e.toVersion === version);
  if (mine.some((e) => e.outcome === "held")) return WAIT;

  if (i.manualUpdate) return { kind: "hold", version, reason: i.manualUpdate };
  const failed = mine.filter((e) => FAILED.has(e.outcome));
  if (failed.some(since(slot.windowStart))) return WAIT;
  if (failed.length >= MAX_FAILED_NIGHTS)
    return {
      kind: "hold",
      version,
      reason: `It did not take on ${MAX_FAILED_NIGHTS} nights, so Deplo waits for a newer version. Click Update to try it again.`,
    };

  if (i.postponedUntil && Date.parse(i.postponedUntil) > i.now.getTime())
    return WAIT;
  const published = i.nextPublishedAt ? Date.parse(i.nextPublishedAt) : NaN;
  if (!i.securityFix && i.now.getTime() - published < SOAK_MS) return WAIT;

  if (i.busy) {
    const retry = slot.last
      ? nextSlotAt(i.now, i.hour, i.timezone)
      : new Date(slot.start.getTime() + 3_600_000);
    const when = retry
      ? ` Deplo tries again ${describeAt(retry, i.now, i.timezone)}.`
      : "";
    return { kind: "skip", version, reason: `${i.busy}.${when}` };
  }
  return { kind: "install", version };
}

/** When the update waiting now installs itself, or null when it never will on its own. */
export function installsAt(i: Omit<AutoUpdateInput, "busy">): Date | null {
  if (!i.active || !i.next || i.manualUpdate) return null;
  const version = versionTag(i.next);
  const mine = i.log.filter((e) => e.toVersion === version);
  if (mine.some((e) => e.outcome === "held")) return null;
  if (mine.filter((e) => FAILED.has(e.outcome)).length >= MAX_FAILED_NIGHTS)
    return null;
  let from = i.now.getTime();
  if (i.postponedUntil) from = Math.max(from, Date.parse(i.postponedUntil));
  const published = i.nextPublishedAt ? Date.parse(i.nextPublishedAt) : NaN;
  if (!i.securityFix && Number.isFinite(published))
    from = Math.max(from, published + SOAK_MS);
  const tonight = currentSlot(new Date(from), i.hour, i.timezone);
  if (
    tonight &&
    mine.some(
      (e) =>
        FAILED.has(e.outcome) &&
        Date.parse(e.at) >= tonight.windowStart.getTime(),
    )
  )
    from = windowEndAfter(new Date(from), i.hour, i.timezone).getTime();
  // A slot under way that has not answered yet still counts.
  const slot = currentSlot(new Date(from), i.hour, i.timezone);
  if (slot && !i.log.some((e) => Date.parse(e.at) >= slot.start.getTime()))
    return new Date(from);
  return nextSlotAt(new Date(from), i.hour, i.timezone);
}

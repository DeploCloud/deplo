import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import type {
  DeploymentStatus,
  DatabaseStatus,
  DomainStatus,
  ServerStatus,
  DestinationStatus,
} from "@/lib/types";

type AnyStatus =
  | DeploymentStatus
  | DatabaseStatus
  | DomainStatus
  | ServerStatus
  | DestinationStatus
  | "active"
  | "idle"
  | "stopping"
  | "restoring"
  | "success"
  | "failed"
  | "never"
  | "running"
  // Live container states, derived from the agent (lib/apps/display-status.ts).
  | "restarting"
  | "degraded"
  | "unhealthy"
  | "down"
  // An app that has never been deployed at all (lib/apps/display-status.ts).
  | "not_deployed"
  // A pull request preview from a fork, held until a maintainer approves it.
  | "blocked"
  // A pull request preview stopped to stay within the app's own limit.
  | "evicted";

const COLORS: Record<string, string> = {
  // green
  ready: "bg-[var(--success)]",
  running: "bg-[var(--success)]",
  online: "bg-[var(--success)]",
  valid: "bg-[var(--success)]",
  connected: "bg-[var(--success)]",
  active: "bg-[var(--success)]",
  success: "bg-[var(--success)]",
  // amber — in-progress / transitioning. "stopping" is the transient state
  // between a Stop click and the container settling to "idle"; it shares the
  // deploying colour so "something is happening" reads the same everywhere.
  building: "bg-[var(--warning)]",
  queued: "bg-[var(--warning)]",
  stopping: "bg-[var(--warning)]",
  // A backup is being put back in place: the stack is down on purpose, for as
  // long as the untar takes.
  restoring: "bg-[var(--warning)]",
  provisioning: "bg-[var(--warning)]",
  pending: "bg-[var(--warning)]",
  unverified: "bg-[var(--warning)]",
  blocked: "bg-[var(--warning)]",
  evicted: "bg-muted-foreground",
  // A domain proxied through Cloudflare, sitting beside `unverified` for the
  // same reason: it IS unverified. Cloudflare's shared anycast IPs mask the
  // origin, so deplo can see that the host is proxied and never whether
  // Cloudflare forwards it here — green would certify a fact no DNS lookup can
  // produce. Not red either: this is equally what a correct setup looks like.
  // Amber says the true thing — "working as far as we can see, unconfirmed" —
  // and the row's notice says what to double-check. Labelled "Proxied" below.
  cloudflare: "bg-[var(--warning)]",
  // Docker is restart-looping the container: it is neither up nor off, it is
  // dying and being started again. Amber + a pulse, like every other "something
  // is happening" state — the red is saved for the deploy that failed outright.
  restarting: "bg-[var(--warning)]",
  // Part of a compose stack is up, part is not.
  degraded: "bg-[var(--warning)]",
  // Running, and failing its own healthcheck. Up is not the same as working.
  unhealthy: "bg-[var(--warning)]",
  // A server whose agent answers but whose host is degraded (Docker unreachable):
  // up, but nothing can deploy there. Amber, not red — the box is not down — and
  // deliberately not grey, which would make a broken host look merely stopped.
  warning: "bg-[var(--warning)]",
  never: "bg-muted-foreground",
  // red — a genuine failure/unreachable state (a crash, a build error, a server
  // that's down). NOT a user-initiated stop; that is "idle" below.
  error: "bg-destructive",
  failed: "bg-destructive",
  misconfigured: "bg-destructive",
  offline: "bg-destructive",
  // Deplo believes this app is deployed and up, and the host has nothing
  // running. Nobody asked for that, so it is a failure, not a "stopped" — grey
  // here would read as "off on purpose", which is the lie we are removing.
  down: "bg-destructive",
  // neutral / grey — "off, but healthy". "idle" is an app the user stopped: it
  // reads as a calm "Stopped", deliberately distinct from the red error states so
  // a stopped container is never mistaken for a crashed one.
  idle: "bg-muted-foreground",
  stopped: "bg-muted-foreground",
  canceled: "bg-muted-foreground",
  // Nothing was ever built for this app. Grey for the same reason "idle" is:
  // nothing is wrong, there is just nothing running yet.
  not_deployed: "bg-muted-foreground",
};

const PULSE = new Set([
  "building",
  "queued",
  "provisioning",
  "stopping",
  "restoring",
  "restarting",
]);

// Maps each status to a translucent Badge variant, used when a caller opts into
// `tinted` (e.g. a green "Online" chip). Mirrors the hues of COLORS: green =
// healthy, amber = in-progress, red = failure, grey = off-but-healthy. Callers
// that don't pass `tinted` keep the plain outline badge, so nothing else moves.
const VARIANTS: Record<string, "success" | "warning" | "destructive" | "muted"> = {
  ready: "success",
  running: "success",
  online: "success",
  valid: "success",
  connected: "success",
  active: "success",
  success: "success",
  building: "warning",
  queued: "warning",
  stopping: "warning",
  restoring: "warning",
  provisioning: "warning",
  pending: "warning",
  unverified: "warning",
  cloudflare: "warning",
  warning: "warning",
  restarting: "warning",
  degraded: "warning",
  unhealthy: "warning",
  error: "destructive",
  failed: "destructive",
  misconfigured: "destructive",
  offline: "destructive",
  down: "destructive",
  never: "muted",
  idle: "muted",
  not_deployed: "muted",
  stopped: "muted",
  canceled: "muted",
};

export function StatusDot({
  status,
  className,
}: {
  status: AnyStatus;
  className?: string;
}) {
  return (
    <span className={cn("relative flex size-2.5 shrink-0", className)}>
      {PULSE.has(status) && (
        <span
          className={cn(
            "absolute inline-flex h-full w-full animate-ping rounded-full opacity-60",
            COLORS[status] ?? "bg-muted-foreground"
          )}
        />
      )}
      <span
        className={cn(
          "relative inline-flex size-2.5 rounded-full",
          COLORS[status] ?? "bg-muted-foreground"
        )}
      />
    </span>
  );
}

/**
 * Friendlier labels for a few raw status keys — the ones whose raw key would
 * read as the wrong thing. Every other status falls back to its capitalized key.
 */
const LABELS: Record<string, string> = {
  idle: "Stopped",
  // Never built, never started. "Stopped" would say someone stopped it, which
  // is the one thing that did not happen — an imported app has simply not shipped
  // yet, and the only control that makes sense on it is a first Deploy.
  not_deployed: "Not deployed",
  // A fork's preview waiting on a maintainer — not a failure, and not something
  // Deplo is doing. "Blocked" would read like an error; this names the action.
  blocked: "Needs approval",
  // Not an error and not a failure: the app hit its own `Live previews` limit
  // and this was the one nobody had touched in the longest, so it was stopped to
  // seat a newer pull request. Named after the SETTING that caused it, so the
  // reader can go turn the number up. Deliberately not red — nothing went wrong,
  // and red here would send people hunting for build logs that do not exist.
  evicted: "Over the limit",
  active: "Running",
  // "Not running", never "Stopped": the app is supposed to be up. The wording
  // has to make an unasked-for outage impossible to mistake for a deliberate one.
  down: "Not running",
  // A domain whose DNS lands on Cloudflare. The raw key would render "Cloudflare",
  // which states a vendor and quietly implies it works; "Proxied" names what deplo
  // actually established — the host goes through a proxy, so what's behind it is
  // out of view. It also stops the status column echoing the row's "Cloudflare
  // DNS" chip word for word.
  cloudflare: "Proxied",
};

export function StatusBadge({
  status,
  tinted,
  labels,
}: {
  status: AnyStatus;
  /**
   * Fill the badge with a translucent, status-coloured background (per
   * {@link VARIANTS}) instead of the default outline — e.g. a green "Online"
   * chip. Off by default so existing call sites are unaffected.
   */
  tinted?: boolean;
  /** Per-status label overrides merged over the defaults, e.g. `{ active: "Online" }`. */
  labels?: Record<string, string>;
}) {
  const key = String(status);
  const label =
    labels?.[key] ?? LABELS[key] ?? key.replace(/^\w/, (c) => c.toUpperCase());
  return (
    <Badge
      variant={tinted ? VARIANTS[key] ?? "muted" : "outline"}
      className={cn("gap-1.5 capitalize", PULSE.has(key) && "animate-pulse")}
    >
      <StatusDot status={status} />
      {label}
    </Badge>
  );
}

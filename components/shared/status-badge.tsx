import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import type {
  DeploymentStatus,
  DatabaseStatus,
  DomainStatus,
  ServerStatus,
  S3Status,
} from "@/lib/types";

type AnyStatus =
  | DeploymentStatus
  | DatabaseStatus
  | DomainStatus
  | ServerStatus
  | S3Status
  | "active"
  | "idle"
  | "stopping"
  | "success"
  | "failed"
  | "never"
  | "running"
  // Live container states, derived from the agent (lib/apps/display-status.ts).
  | "restarting"
  | "degraded"
  | "unhealthy"
  | "down";

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
  provisioning: "bg-[var(--warning)]",
  pending: "bg-[var(--warning)]",
  unverified: "bg-[var(--warning)]",
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
};

const PULSE = new Set([
  "building",
  "queued",
  "provisioning",
  "stopping",
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

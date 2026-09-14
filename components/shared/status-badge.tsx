import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import type { DestinationStatus } from "@/lib/types/backup";
import type { DatabaseStatus } from "@/lib/types/database";
import type { DeploymentStatus } from "@/lib/types/deployment";
import type { DomainStatus } from "@/lib/types/domain";
import type { ServerStatus } from "@/lib/types/server";

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
  | "restarting"
  | "unhealthy"
  | "down"
  | "not_deployed"
  | "blocked"
  | "evicted";

const COLORS: Record<string, string> = {
  ready: "bg-[var(--success)]",
  running: "bg-[var(--success)]",
  online: "bg-[var(--success)]",
  valid: "bg-[var(--success)]",
  connected: "bg-[var(--success)]",
  active: "bg-[var(--success)]",
  success: "bg-[var(--success)]",
  building: "bg-[var(--warning)]",
  queued: "bg-[var(--warning)]",
  stopping: "bg-[var(--warning)]",
  restoring: "bg-[var(--warning)]",
  provisioning: "bg-[var(--warning)]",
  pending: "bg-[var(--warning)]",
  unverified: "bg-[var(--warning)]",
  blocked: "bg-[var(--warning)]",
  evicted: "bg-muted-foreground",
  cloudflare: "bg-[var(--warning)]",
  restarting: "bg-[var(--warning)]",
  unhealthy: "bg-[var(--warning)]",
  warning: "bg-[var(--warning)]",
  never: "bg-muted-foreground",
  error: "bg-destructive",
  failed: "bg-destructive",
  misconfigured: "bg-destructive",
  offline: "bg-destructive",
  down: "bg-destructive",
  idle: "bg-muted-foreground",
  stopped: "bg-muted-foreground",
  canceled: "bg-muted-foreground",
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

const VARIANTS: Record<
  string,
  "success" | "warning" | "destructive" | "muted"
> = {
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
            COLORS[status] ?? "bg-muted-foreground",
          )}
        />
      )}
      <span
        className={cn(
          "relative inline-flex size-2.5 rounded-full",
          COLORS[status] ?? "bg-muted-foreground",
        )}
      />
    </span>
  );
}

const LABELS: Record<string, string> = {
  idle: "Stopped",
  not_deployed: "Not deployed",
  blocked: "Needs approval",
  evicted: "Over the limit",
  active: "Running",
  down: "Not running",
  cloudflare: "Proxied",
};

export function StatusBadge({
  status,
  tinted,
  labels,
}: {
  status: AnyStatus;
  tinted?: boolean;
  labels?: Record<string, string>;
}) {
  const key = String(status);
  const label =
    labels?.[key] ?? LABELS[key] ?? key.replace(/^\w/, (c) => c.toUpperCase());
  return (
    <Badge
      variant={tinted ? (VARIANTS[key] ?? "muted") : "outline"}
      className={cn("gap-1.5 capitalize", PULSE.has(key) && "animate-pulse")}
    >
      <StatusDot status={status} />
      {label}
    </Badge>
  );
}

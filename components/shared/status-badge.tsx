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
  | "running";

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
  never: "bg-muted-foreground",
  // red — a genuine failure/unreachable state (a crash, a build error, a server
  // that's down). NOT a user-initiated stop; that is "idle" below.
  error: "bg-destructive",
  failed: "bg-destructive",
  misconfigured: "bg-destructive",
  offline: "bg-destructive",
  // neutral / grey — "off, but healthy". "idle" is a service the user stopped: it
  // reads as a calm "Stopped", deliberately distinct from the red error states so
  // a stopped container is never mistaken for a crashed one.
  idle: "bg-muted-foreground",
  stopped: "bg-muted-foreground",
  canceled: "bg-muted-foreground",
};

const PULSE = new Set(["building", "queued", "provisioning", "stopping"]);

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
 * Friendlier labels for a few raw status keys. Only the service-lifecycle states
 * are remapped — a user-stopped service reads "Stopped" (not "Idle") and a
 * running one "Running" (not "Active"); every other status falls back to its
 * capitalized key.
 */
const LABELS: Record<string, string> = {
  idle: "Stopped",
  active: "Running",
};

export function StatusBadge({ status }: { status: AnyStatus }) {
  const key = String(status);
  const label = LABELS[key] ?? key.replace(/^\w/, (c) => c.toUpperCase());
  return (
    <Badge
      variant="outline"
      className={cn("gap-1.5 capitalize", PULSE.has(key) && "animate-pulse")}
    >
      <StatusDot status={status} />
      {label}
    </Badge>
  );
}

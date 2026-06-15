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
  // amber
  building: "bg-[var(--warning)]",
  queued: "bg-[var(--warning)]",
  provisioning: "bg-[var(--warning)]",
  pending: "bg-[var(--warning)]",
  unverified: "bg-[var(--warning)]",
  idle: "bg-[var(--warning)]",
  never: "bg-muted-foreground",
  // red
  error: "bg-destructive",
  failed: "bg-destructive",
  misconfigured: "bg-destructive",
  offline: "bg-destructive",
  // neutral
  stopped: "bg-muted-foreground",
  canceled: "bg-muted-foreground",
};

const PULSE = new Set(["building", "queued", "provisioning"]);

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

export function StatusBadge({ status }: { status: AnyStatus }) {
  const label = String(status).replace(/^\w/, (c) => c.toUpperCase());
  return (
    <Badge variant="outline" className="gap-1.5 capitalize">
      <StatusDot status={status} />
      {label}
    </Badge>
  );
}

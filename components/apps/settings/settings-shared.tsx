import * as React from "react";
import { AlertCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoTip } from "@/components/ui/info-tip";
import { DocsLink } from "@/components/ui/docs-link";
import { cn } from "@/lib/utils";
import type { DocsTopic } from "@/lib/docs";

export interface SettingsServer {
  id: string;
  name: string;
  type: "localhost" | "remote";
  isDeploHost: boolean;
}

export function SettingsSection({
  icon: Icon,
  title,
  info,
  docs,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  info?: React.ReactNode;
  docs?: DocsTopic;
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="size-4 text-muted-foreground" />
      <h2 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
        {title}
      </h2>
      {info != null ? (
        <InfoTip content={info} docs={docs} />
      ) : (
        docs && <DocsLink topic={docs} className="text-xs normal-case" />
      )}
    </div>
  );
}

export function DirtyHint({ dirty }: { dirty: boolean }) {
  return (
    <span role="status" aria-live="polite" className="flex items-center">
      {dirty && (
        <Badge variant="warning" className="gap-1.5 border-warning/40">
          <AlertCircle aria-hidden className="size-3.5" />
          Unsaved changes
        </Badge>
      )}
    </span>
  );
}

// A card of FeatureRows. The [&>p] rule places CapabilityFieldset's read-only note.
export function RowsCard({
  icon: Icon,
  title,
  info,
  docs,
  danger = false,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  info?: React.ReactNode;
  docs?: DocsTopic;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card className={cn(danger && "border-destructive/40")}>
      <CardHeader>
        <CardTitle
          className={cn(
            "flex w-fit items-center gap-2 text-base",
            danger && "text-destructive",
          )}
        >
          <Icon className={cn("size-4", !danger && "text-muted-foreground")} />
          {title}
          {info != null && <InfoTip content={info} docs={docs} />}
        </CardTitle>
      </CardHeader>
      <div className="[&>p]:mx-6 [&>p]:mb-4">{children}</div>
    </Card>
  );
}

export function FeatureRow({
  id,
  icon: Icon,
  title,
  badge,
  info,
  docs,
  description,
  control,
  children,
}: {
  id?: string;
  icon?: React.ComponentType<{ className?: string }>;
  title: React.ReactNode;
  badge?: React.ReactNode;
  info?: React.ReactNode;
  docs?: DocsTopic;
  description?: React.ReactNode;
  control?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div id={id} className="scroll-mt-20 border-t border-border px-6 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-56 flex-1">
          <p className="flex items-center gap-2 text-sm font-medium">
            {Icon && <Icon className="size-4 text-muted-foreground" />}
            {title}
            {badge}
            {info != null && <InfoTip content={info} docs={docs} />}
          </p>
          {description != null && (
            <p className="mt-1 text-xs text-muted-foreground">{description}</p>
          )}
        </div>
        {control != null && (
          <div className="flex shrink-0 items-center gap-3">{control}</div>
        )}
      </div>
      {children}
    </div>
  );
}

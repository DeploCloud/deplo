import * as React from "react";
import { AlertCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { InfoTip } from "@/components/ui/info-tip";
import { DocsLink } from "@/components/ui/docs-link";
import type { DocsTopic } from "@/lib/docs";

// SettingsServer: a server whose id/name/type feed the Deploy Source server picker.
export interface SettingsServer {
  id: string;
  name: string;
  type: "localhost" | "remote";
  isDeploHost: boolean;
}

// SettingsSection heads an app-settings page with the section's icon and a hairline.
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

// DirtyHint is the "unsaved changes" cue on a card footer, beside its Save button.
export function DirtyHint({ dirty }: { dirty: boolean }) {
  // The span always renders so it stays a stable ARIA live region.
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

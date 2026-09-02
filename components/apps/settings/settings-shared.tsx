import * as React from "react";
import { AlertCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { InfoTip } from "@/components/ui/info-tip";
import { DocsLink } from "@/components/ui/docs-link";
import type { DocsTopic } from "@/lib/docs";

/** A server whose id/name/type feed the Deploy Source server picker. */
export interface SettingsServer {
  id: string;
  name: string;
  type: "localhost" | "remote";
  isDeploHost: boolean;
}

/**
 * Heads an app-settings page (General, Deployment, Storage, Access) with the
 * section's icon and a hairline.
 */
export function SettingsSection({
  icon: Icon,
  title,
  info,
  docs,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  /** Optional explanation for the section, shown via a trailing info icon. */
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
        // No tooltip to hang it on: the link is the section's own affordance,
        // and it works on touch, which a hover tooltip does not.
        docs && <DocsLink topic={docs} className="text-xs normal-case" />
      )}
    </div>
  );
}

/**
 * The "unsaved changes" cue on a card footer, beside the Save button it belongs
 * to. A warning chip rather than a muted line: work that would be lost on the
 * next navigation has to be seen without being looked for.
 */
export function DirtyHint({ dirty }: { dirty: boolean }) {
  // Always render the span so it's a stable ARIA live region (its text is announced
  // when a section becomes dirty).
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

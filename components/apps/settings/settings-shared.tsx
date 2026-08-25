import * as React from "react";
import { InfoTip } from "@/components/ui/info-tip";

/** A server whose id/name/type feed the Deploy Source server picker. */
export interface SettingsServer {
  id: string;
  name: string;
  type: "localhost" | "remote";
}

/**
 * Heads an app-settings page (General, Deployment, Storage, Access) with the
 * section's icon and a hairline.
 */
export function SettingsSection({
  icon: Icon,
  title,
  info,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  /** Optional explanation for the section, shown via a trailing info icon. */
  info?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="size-4 text-muted-foreground" />
      <h2 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
        {title}
      </h2>
      {info != null && <InfoTip content={info} />}
    </div>
  );
}

/**
 * A muted "unsaved changes" cue shown on the left of a card footer while that
 * section has pending edits (paired with its Save button, which is disabled until
 * then).
 */
export function DirtyHint({ dirty }: { dirty: boolean }) {
  // Always render the span so it's a stable ARIA live region (its text is announced
  // when a section becomes dirty).
  return (
    <span
      role="status"
      aria-live="polite"
      className="flex items-center gap-1.5 text-xs text-muted-foreground"
    >
      {dirty && (
        <>
          <span aria-hidden className="size-1.5 rounded-full bg-warning" />
          Unsaved changes
        </>
      )}
    </span>
  );
}

import * as React from "react";

/** A server whose id/name/type feed the Deploy Source server picker. */
export interface SettingsServer {
  id: string;
  name: string;
  type: "localhost" | "remote";
}

/**
 * Heads a service-settings page (General, Deployment, Storage, Access) with the
 * section's icon and a hairline. Now that each settings section is its own
 * dedicated page, this reuses the exact chrome the old single-scroll page put
 * above each group so the pages keep a consistent, anchored heading.
 */
export function SettingsSection({
  icon: Icon,
  title,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
}) {
  return (
    <div className="flex items-center gap-2 border-b border-border pb-2">
      <Icon className="size-4 text-muted-foreground" />
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h2>
    </div>
  );
}

/**
 * A muted "unsaved changes" cue shown on the left of a card footer while that
 * section has pending edits (paired with its Save button, which is disabled
 * until then). Its slot is always reserved (opacity toggles, not display) so the
 * Save button never shifts as the cue appears or clears.
 */
export function DirtyHint({ dirty }: { dirty: boolean }) {
  // Always render the span so it's a stable ARIA live region (its text is
  // announced when a section becomes dirty). Empty when clean; as the footer's
  // first justify-between child it holds the left edge so the Save button never
  // shifts as the cue appears or clears.
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

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { cn } from "@/lib/utils";
import { docsUrl, type DocsTopic } from "@/lib/docs";

/**
 * The way out of the interface and into the manual. Plain `<a>`, no hooks, so it
 * renders inside a server component and inside a tooltip alike.
 */
export function DocsLink({
  topic,
  label = "Learn more",
  className,
}: {
  topic: DocsTopic;
  /** Overrides "Learn more" where a named section reads better. */
  label?: string;
  className?: string;
}) {
  return (
    <a
      href={docsUrl(topic)}
      target="_blank"
      rel="noreferrer"
      className={cn(
        "font-medium text-foreground underline underline-offset-2 hover:no-underline",
        className,
      )}
    >
      {label}
    </a>
  );
}

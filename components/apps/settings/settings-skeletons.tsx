// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { Skeleton } from "@/components/ui/skeleton";

/**
 * An uppercase section label placeholder with its leading icon + hairline -
 * mirrors {@link SettingsSection} so a settings page's loading skeleton keeps the
 * same anchored heading the page itself renders.
 */
export function SectionLabel({ width }: { width: string }) {
  return (
    <div className="flex items-center gap-2">
      <Skeleton className="size-4 rounded" />
      <Skeleton className={`h-3 ${width}`} />
    </div>
  );
}

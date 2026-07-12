import { Skeleton } from "@/components/ui/skeleton";

/**
 * An uppercase section label placeholder with its leading icon + hairline —
 * mirrors {@link SettingsSection} so a settings page's loading skeleton keeps the
 * same anchored heading the page itself renders. Shared by the per-section
 * `loading.tsx` files under `/services/[slug]/settings`.
 */
export function SectionLabel({ width }: { width: string }) {
  return (
    <div className="flex items-center gap-2 border-b border-border pb-2">
      <Skeleton className="size-4 rounded" />
      <Skeleton className={`h-3 ${width}`} />
    </div>
  );
}

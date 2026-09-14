import { Skeleton } from "@/components/ui/skeleton";

// SectionLabel - loading placeholder that mirrors SettingsSection's heading.
export function SectionLabel({ width }: { width: string }) {
  return (
    <div className="flex items-center gap-2">
      <Skeleton className="size-4 rounded" />
      <Skeleton className={`h-3 ${width}`} />
    </div>
  );
}

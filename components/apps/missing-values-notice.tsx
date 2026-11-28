import { TriangleAlert } from "lucide-react";
import Link from "@/components/ui/link";
import { Button } from "@/components/ui/button";

// A deploy is never held for it: many .env.example names are optional.
export function MissingValuesNotice({
  slug,
  count,
}: {
  slug: string;
  count: number;
}) {
  if (count === 0) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning/40 bg-warning-wash-strong px-3.5 py-2.5 text-sm">
      <div className="flex items-start gap-2.5">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
        <div>
          <p className="font-medium text-warning">
            {count === 1
              ? "1 variable still needs a value"
              : `${count} variables still need a value`}
          </p>
          <p className="mt-1 text-muted-foreground">
            The app&apos;s .env.example lists them. It may not start without
            them.
          </p>
        </div>
      </div>
      <Button asChild variant="outline" size="sm">
        <Link href={`/apps/${slug}/environment`}>Fill them in</Link>
      </Button>
    </div>
  );
}

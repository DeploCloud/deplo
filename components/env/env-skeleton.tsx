import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

/**
 * Loading skeletons for the environment-variables UI.
 */

// Per-row shape, varied so the placeholder reads as real data instead of a perfect
// grid.
const ROWS = [
  { key: "w-28", value: "w-40", when: "w-20", author: true, masked: false },
  { key: "w-40", value: "w-24", when: "w-16", author: true, masked: true },
  { key: "w-24", value: "w-52", when: "w-24", author: false, masked: false },
  { key: "w-36", value: "w-32", when: "w-16", author: true, masked: true },
  { key: "w-32", value: "w-44", when: "w-20", author: true, masked: false },
  { key: "w-44", value: "w-28", when: "w-24", author: false, masked: false },
];

// 90ms between rows - enough to read as a wave, short enough to feel alive. A
// negative delay starts each row mid-cycle so the whole table is already in motion
// on first paint.
const rowDelay = (i: number): React.CSSProperties =>
  ({ "--shimmer-delay": `-${(i * 0.09).toFixed(2)}s` }) as React.CSSProperties;

/**
 * The bordered env-vars table: a header row plus `rows` body rows rendered with
 * the real Table primitives on the same Key / Value / Last modified / Modified by
 * / Actions columns the live table uses.
 */
export function EnvTableSkeleton({
  rows = 5,
  actions = true,
  className,
}: {
  rows?: number;
  actions?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("rounded-xl border border-border", className)}>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>
              <Skeleton shimmer className="h-3 w-8" />
            </TableHead>
            <TableHead>
              <Skeleton shimmer className="h-3 w-10" />
            </TableHead>
            <TableHead>
              <Skeleton shimmer className="h-3 w-20" />
            </TableHead>
            <TableHead>
              <Skeleton shimmer className="h-3 w-20" />
            </TableHead>
            {actions && (
              <TableHead className="text-right">
                <Skeleton shimmer className="ml-auto h-3 w-12" />
              </TableHead>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: rows }).map((_, i) => {
            const r = ROWS[i % ROWS.length];
            const delay = rowDelay(i + 1);
            return (
              <TableRow key={i} className="hover:bg-transparent">
                {/* Key (mono) */}
                <TableCell>
                  <Skeleton
                    shimmer
                    style={delay}
                    className={cn("h-4", r.key)}
                  />
                </TableCell>

                {/* Value (+ secret eye dot) */}
                <TableCell>
                  <div className="flex items-center gap-1.5">
                    <Skeleton
                      shimmer
                      style={delay}
                      className={cn("h-4", r.value)}
                    />
                    {r.masked && (
                      <Skeleton
                        shimmer
                        style={delay}
                        className="size-3.5 shrink-0 rounded-full"
                      />
                    )}
                  </div>
                </TableCell>

                {/* Last modified ("3 days ago") */}
                <TableCell>
                  <Skeleton
                    shimmer
                    style={delay}
                    className={cn("h-3", r.when)}
                  />
                </TableCell>

                {/* Modified by (avatar + @username), or the em dash */}
                <TableCell>
                  {r.author ? (
                    <div className="flex items-center gap-2">
                      <Skeleton
                        shimmer
                        style={delay}
                        className="size-5 shrink-0 rounded-full"
                      />
                      <Skeleton shimmer style={delay} className="h-3 w-16" />
                    </div>
                  ) : (
                    <Skeleton shimmer style={delay} className="h-3 w-3" />
                  )}
                </TableCell>

                {/* Row actions */}
                {actions && (
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Skeleton
                        shimmer
                        style={delay}
                        className="size-8 rounded-md"
                      />
                      <Skeleton
                        shimmer
                        style={delay}
                        className="size-8 rounded-md"
                      />
                    </div>
                  </TableCell>
                )}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * Full loading state for an app's Environment Variables tab: the title block, then
 * the toolbar row <EnvManager> renders - the search/filter/sort bar on the left,
 * the Reveal all / Add / view-toggle actions pinned right - above the table.
 */
export function EnvManagerSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div
      className="space-y-4"
      role="status"
      aria-label="Loading environment variables"
      aria-busy
    >
      <div className="space-y-2">
        <Skeleton shimmer className="h-5 w-44" />
        <Skeleton shimmer className="h-4 w-72" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {/* Search input (flex-1) + the Author / Type / Sort selects */}
        <Skeleton shimmer className="h-9 min-w-[12rem] flex-1 rounded-md" />
        <Skeleton shimmer className="h-9 w-[140px] rounded-md" />
        <Skeleton shimmer className="h-9 w-[180px] rounded-md" />
        <div className="ml-auto flex items-center gap-2">
          <Skeleton shimmer className="h-8 w-28 rounded-md" />
          <Skeleton shimmer className="h-8 w-16 rounded-md" />
          <Skeleton shimmer className="h-8 w-[150px] rounded-lg" />
        </div>
      </div>
      <EnvTableSkeleton rows={rows} />
    </div>
  );
}

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
 * Loading skeletons for the environment-variables UI. They mirror the real DOM
 * of <EnvManager> (toolbar + table) so the page doesn't jump when the data
 * arrives — crucially the table reuses the SAME <Table>/<TableRow>/<TableCell>
 * primitives the live table does, so cell padding, header height and the
 * content-driven column widths line up instead of drifting against a hand-rolled
 * grid. Each row is offset via the `--shimmer-delay` custom property so the
 * highlight cascades down rather than every bar pulsing in unison.
 */

// Per-row shape, varied so the placeholder reads as real data instead of a
// perfect grid. `envs` is how many environment badges to draw, `masked` adds
// the little "secret" eye dot in the value cell.
const ROWS = [
  { key: "w-28", value: "w-40", envs: 3, masked: false },
  { key: "w-40", value: "w-24", envs: 1, masked: true },
  { key: "w-24", value: "w-52", envs: 2, masked: false },
  { key: "w-36", value: "w-32", envs: 3, masked: true },
  { key: "w-32", value: "w-44", envs: 2, masked: false },
  { key: "w-44", value: "w-28", envs: 1, masked: false },
];

const BADGE_W = ["w-14", "w-16", "w-20"];

// 90ms between rows — enough to read as a wave, short enough to feel alive. A
// negative delay starts each row mid-cycle so the whole table is already in
// motion on first paint. Set as a custom property the .animate-shimmer ::after
// overlay reads (inline style can't target a pseudo-element directly).
const rowDelay = (i: number): React.CSSProperties =>
  ({ "--shimmer-delay": `-${(i * 0.09).toFixed(2)}s` }) as React.CSSProperties;

/**
 * The bordered env-vars table: a header row plus `rows` body rows rendered with
 * the real Table primitives on the same Key / Value / Environments / Actions
 * columns the live table uses. Set `actions={false}` for the read-only tables
 * (e.g. the Variables page cards) whose last column is targets, not row actions.
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
                  <Skeleton shimmer style={delay} className={cn("h-4", r.key)} />
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

                {/* Environment badges */}
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {Array.from({ length: r.envs }).map((_, b) => (
                      <Skeleton
                        key={b}
                        shimmer
                        style={delay}
                        className={cn("h-5 rounded-md", BADGE_W[b % BADGE_W.length])}
                      />
                    ))}
                  </div>
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
 * Full loading state for an app's Environment Variables tab: the header +
 * toolbar (Reveal all, Add, view toggle) above the table.
 */
export function EnvManagerSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div
      className="space-y-4"
      role="status"
      aria-label="Loading environment variables"
      aria-busy
    >
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-2">
          <Skeleton shimmer className="h-5 w-44" />
          <Skeleton shimmer className="h-4 w-72" />
        </div>
        <div className="flex items-center gap-2">
          <Skeleton shimmer className="h-8 w-28 rounded-md" />
          <Skeleton shimmer className="h-8 w-16 rounded-md" />
          <Skeleton shimmer className="h-8 w-[150px] rounded-lg" />
        </div>
      </div>
      <EnvTableSkeleton rows={rows} />
    </div>
  );
}

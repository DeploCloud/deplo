"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { TableCell, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { ActionResult } from "@/lib/result";

/**
 * Optimistic creation: the thing appears the instant you ask for it.
 *
 * The dialogs that create something real on a host — a domain, a database, an
 * S3 destination, a basic-auth credential — used to hold the user hostage
 * inside the modal with a spinning "Adding…" button while the control plane
 * talked to the server agent. That is the slowest-feeling shape a UI can have:
 * a frozen form, no context, nothing to look at.
 *
 * Instead: the dialog closes immediately and a PLACEHOLDER card/row takes the
 * new item's place in the list right away, pulsing, carrying the name the user
 * typed and what is happening to it ("Adding domain…"). The work runs in the
 * background. It is not a lie — the placeholder never pretends to be finished:
 * it pulses, it is not interactive, and it says what it is waiting on. When the
 * mutation lands, the real card replaces it in the same commit (see `create`);
 * if it fails, the placeholder disappears, the server's message is toasted and
 * the dialog reopens with exactly what was typed.
 *
 * Wiring (one provider per list; two lists on a page get two providers, so a
 * pending database never shows up in the S3 grid):
 *
 *     <PendingCreateProvider>              // usually right in the RSC page
 *       <CreateThing />                    // calls create() from usePendingCreate()
 *       <PendingList empty={things.length === 0} emptyState={<EmptyState … />}>
 *         <div className="grid …">
 *           {things.map((t) => <ThingCard key={t.id} … />)}
 *           <PendingCards />               // the placeholders live here
 *         </div>
 *       </PendingList>
 *     </PendingCreateProvider>
 */
export type PendingCreate = {
  id: string;
  /** What the user typed — the identity of the thing being created. */
  label: string;
  /** What is happening to it, present tense: "Adding domain…", "Connecting…". */
  note: string;
  /**
   * The mutation came back OK and the refresh is on its way. The placeholder
   * stays on screen anyway until the real row LANDS (see `count`) — dropping it
   * when the promise resolves leaves a visible hole: measured at ~400ms of
   * "No login required" between the placeholder going and the card arriving.
   */
  settled: boolean;
};

/** How long a settled placeholder waits for its real row before giving up and
 *  removing itself — a backstop for a refresh that never lands. */
const ARRIVAL_TIMEOUT_MS = 15_000;

type CreateOptions<T> = {
  /** Toasted when the background work actually finished. */
  success?: string;
  onSuccess?: (data: T | undefined) => void;
  /**
   * Called with the server's message after it has been toasted — the dialog
   * uses it to reopen itself with the values the user typed, which a modal that
   * closed optimistically would otherwise have thrown away.
   */
  onError?: (error: string) => void;
};

type PendingCreateApi = {
  pending: PendingCreate[];
  create: <T>(
    placeholder: { label: string; note: string },
    mutate: () => Promise<ActionResult<T>>,
    opts?: CreateOptions<T>,
  ) => void;
};

const PendingCreateContext = React.createContext<PendingCreateApi | null>(null);

export function PendingCreateProvider({
  count,
  children,
}: {
  /**
   * How many of these things the server currently lists (`domains.length`,
   * `users.length`, …). This is the ARRIVAL SIGNAL: when a refresh brings a
   * bigger number, the matching placeholder is retired in that very render, so
   * the real row replaces it with no gap and no double.
   */
  count: number;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState<PendingCreate[]>([]);
  const [, startTransition] = React.useTransition();
  const nextId = React.useRef(0);
  const seen = React.useRef(count);

  // Adjusting state during render (React's own "derive from props" escape
  // hatch): the alternative, an effect, runs AFTER the commit, which is exactly
  // one frame of the placeholder and the real row side by side.
  if (count !== seen.current) {
    const landed = count - seen.current;
    seen.current = count;
    if (landed > 0) {
      const retiring = pending.filter((p) => p.settled).slice(0, landed);
      if (retiring.length > 0) {
        const drop = new Set(retiring.map((p) => p.id));
        setPending((p) => p.filter((x) => !drop.has(x.id)));
      }
    }
  }

  const create = React.useCallback<PendingCreateApi["create"]>(
    (placeholder, mutate, opts) => {
      const id = `pending-${nextId.current++}`;
      setPending((p) => [...p, { ...placeholder, id, settled: false }]);

      // The transition is owned by the PROVIDER, not the dialog: the dialog is
      // closed (and may be unmounted) long before the work finishes, and a
      // transition whose owner is gone can no longer commit anything.
      startTransition(async () => {
        const res = await mutate();
        if (!res.ok) {
          setPending((p) => p.filter((x) => x.id !== id));
          toast.error(res.error);
          // Refresh on failure too: several of these mutations write the row
          // first and fail later, on the part that touches the server agent —
          // an error can still leave something real the user has to see.
          router.refresh();
          opts?.onError?.(res.error);
          return;
        }
        if (opts?.success) toast.success(opts.success);
        // Ask for the real row and mark the placeholder settled — it keeps its
        // seat until `count` says the row is actually rendered. The timer is
        // only a backstop for a refresh that never brings one.
        router.refresh();
        setPending((p) =>
          p.map((x) => (x.id === id ? { ...x, settled: true } : x)),
        );
        window.setTimeout(
          () => setPending((p) => p.filter((x) => x.id !== id)),
          ARRIVAL_TIMEOUT_MS,
        );
        opts?.onSuccess?.(res.data);
      });
    },
    [router],
  );

  const value = React.useMemo<PendingCreateApi>(
    () => ({ pending, create }),
    [pending, create],
  );

  return (
    <PendingCreateContext.Provider value={value}>
      {children}
    </PendingCreateContext.Provider>
  );
}

export function usePendingCreate(): PendingCreateApi {
  const ctx = React.useContext(PendingCreateContext);
  if (!ctx)
    throw new Error(
      "usePendingCreate must be used inside a <PendingCreateProvider>",
    );
  return ctx;
}

/**
 * Renders the list, falling back to `emptyState` only when there is genuinely
 * nothing to show — not even a creation in flight. Without this, adding the
 * FIRST item of a list would have nowhere to put its placeholder: the page is
 * still showing "No domains yet".
 */
export function PendingList({
  empty,
  emptyState,
  children,
}: {
  empty: boolean;
  emptyState: React.ReactNode;
  children: React.ReactNode;
}) {
  const { pending } = usePendingCreate();
  if (empty && pending.length === 0) return <>{emptyState}</>;
  return (
    <>
      {children}
      {/* The empty state usually carries its own "Add …" dialog — the one the
          user just submitted from, when this is the FIRST item of the list.
          Swapping it out would unmount that dialog mid-flight and throw away
          what was typed, so it stays mounted (and out of the a11y tree) until
          the real item lands: a rejected create can then reopen it, values
          intact. Its content portals to the body, so a reopen still shows. */}
      {empty && <div className="hidden">{emptyState}</div>}
    </>
  );
}

/**
 * The placeholders as CARDS — drop this inside the same grid container as the
 * real cards so they flow with them.
 */
export function PendingCards({
  /** Skeleton bars under the name, to land near the real card's height. */
  lines = 2,
  className,
}: {
  lines?: number;
  className?: string;
}) {
  const { pending } = usePendingCreate();
  return (
    <>
      {pending.map((item) => (
        <Card
          key={item.id}
          aria-busy
          className={cn(
            "animate-pulse select-none border-dashed bg-card/60",
            className,
          )}
        >
          <CardContent className="space-y-4 p-5">
            <div className="flex items-center gap-3">
              <div className="size-10 shrink-0 rounded-lg border border-dashed border-border bg-secondary" />
              <div className="min-w-0 space-y-1.5">
                <p className="truncate text-sm font-medium">{item.label}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {item.note}
                </p>
              </div>
            </div>
            {lines > 0 && (
              <div className="space-y-2">
                {Array.from({ length: lines }).map((_, i) => (
                  <div
                    key={i}
                    className="h-3 rounded bg-muted"
                    style={{ width: i % 2 === 0 ? "70%" : "45%" }}
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </>
  );
}

/**
 * The placeholders as TABLE ROWS — drop this inside `<TableBody>` after the
 * real rows. `columns` is the table's column count; the name occupies the first
 * cell and the rest are skeleton bars, so the row keeps the table's shape.
 */
export function PendingRows({ columns }: { columns: number }) {
  const { pending } = usePendingCreate();
  return (
    <>
      {pending.map((item) => (
        <TableRow key={item.id} aria-busy className="animate-pulse select-none">
          <TableCell>
            <div className="space-y-1">
              <p className="truncate text-sm font-medium">{item.label}</p>
              <p className="truncate text-xs text-muted-foreground">
                {item.note}
              </p>
            </div>
          </TableCell>
          {Array.from({ length: Math.max(0, columns - 1) }).map((_, i) => (
            <TableCell key={i}>
              <div className="h-3 w-16 rounded bg-muted" />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  );
}

"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { TableCell, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { ActionResult } from "@/lib/result";

export type PendingCreate = {
  id: string;
  label: string;
  note: string;
  settled: boolean;
};

const ARRIVAL_TIMEOUT_MS = 15_000;

type CreateOptions<T> = {
  success?: string;
  onSuccess?: (data: T | undefined) => void;
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
  count: number;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState<PendingCreate[]>([]);
  const [, startTransition] = React.useTransition();
  const nextId = React.useRef(0);
  const [seen, setSeen] = React.useState(count);

  if (count !== seen) {
    const landed = count - seen;
    setSeen(count);
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

      startTransition(async () => {
        const res = await mutate();
        if (!res.ok) {
          setPending((p) => p.filter((x) => x.id !== id));
          toast.error(res.error);
          router.refresh();
          opts?.onError?.(res.error);
          return;
        }
        if (opts?.success) toast.success(opts.success);
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
      {empty && <div className="hidden">{emptyState}</div>}
    </>
  );
}

export function PendingCards({
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
            "animate-pulse border-dashed bg-card select-none",
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

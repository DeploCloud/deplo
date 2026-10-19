import type { ReactNode } from "react";

export function DomainNoticeContent({
  children,
  action,
}: {
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 flex-1 space-y-1.5">{children}</div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

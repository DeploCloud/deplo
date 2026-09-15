import { ServerOff } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";

export function HostUnavailable({
  what,
  reason,
}: {
  what: string;
  reason: string;
}) {
  return (
    <EmptyState
      icon={ServerOff}
      title={`${what} unavailable`}
      description={reason}
      className="py-10"
    />
  );
}

import { ServerOff } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";

// HostUnavailable is what a server card shows when the host did not answer; the reason is the server's, verbatim.
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

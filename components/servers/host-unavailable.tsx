import { ServerOff } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";

/**
 * What a card on a server's page shows when its host did not answer: which card
 * is missing, and why. The reason comes from the server verbatim.
 */
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

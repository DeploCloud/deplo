import type { DestinationOption } from "@/lib/data/destinations/dto";

export type Destination = DestinationOption;

// BackupTarget - what a backups panel backs up: one app, or one database.
export interface BackupTarget {
  kind: "app" | "database";
  id: string;
  name: string;
  // The server it runs on - every destination picker flags a destination that
  // sits on that same disk. Null when the target's server is unknown.
  serverId: string | null;
}

// noun - the noun for this target, for the sentences that have to name it.
export const noun = (t: BackupTarget) =>
  t.kind === "app" ? "app" : "database";

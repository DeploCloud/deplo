import type { DestinationOption } from "@/lib/data/destinations/dto";

export type Destination = DestinationOption;

export interface BackupTarget {
  kind: "app" | "database";
  id: string;
  name: string;
  serverId: string | null;
}

export const noun = (t: BackupTarget) =>
  t.kind === "app" ? "app" : "database";

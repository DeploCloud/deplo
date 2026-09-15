import type { SharedRef } from "../../map/env";
import type { SourceDatabase, SourceMount } from "../../model";

export interface CoolifyExtras {
  env?: string;
  envNotes?: string[];
  sharedRefs?: SharedRef[];
  secretEnvKeys?: string[];
  mounts?: SourceMount[];
  serverId?: string;
  environmentId?: string;
  stackDir?: string;
  basicAuth?: { username: string; password: string } | null;
  backups?: SourceDatabase["backups"];
  previewEnv?: string;
}

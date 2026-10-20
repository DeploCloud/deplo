import type { SharedRef } from "../../map/env";
import type { SourceDatabase, SourceMount } from "../../model";
import type { Note } from "../../note";

export interface CoolifyExtras {
  env?: string;
  envNotes?: Note[];
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

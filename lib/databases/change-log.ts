import type { Database } from "../types/database";
import { isOfficialEngineImage } from "./images";

/** Where Postgres leaves its change log for the server agent, under its data directory: the agent reads the same name. */
export const CHANGE_LOG_DIR = "deplo-wal";

/** How long a piece of the change log waits on the member to be collected before Postgres drops it. */
export const CHANGE_LOG_KEPT_MINUTES = 30;

/** A Postgres database on a cluster archives its change log, unless it runs someone else's image or command. */
export function archivesChangeLog(
  db: Pick<Database, "type" | "clusterId" | "customImage" | "customCommand">,
): boolean {
  return (
    db.type === "postgres" &&
    !!db.clusterId &&
    !db.customCommand?.trim() &&
    (!db.customImage?.trim() ||
      isOfficialEngineImage("postgres", db.customImage))
  );
}

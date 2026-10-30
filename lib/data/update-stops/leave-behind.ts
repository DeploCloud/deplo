import "server-only";

import { requireInstanceAdmin } from "../../membership";
import type { UpdateInfo } from "../updates";

export const NOTHING_TO_LEAVE_BEHIND =
  "Deplo no longer waits on servers to update, so there is no server to leave behind.";

/** Deprecated for one release (ADR-0041): no stop waits on servers, so an older API client is refused in plain words. */
export async function leaveServerBehind(): Promise<UpdateInfo> {
  await requireInstanceAdmin();
  throw new Error(NOTHING_TO_LEAVE_BEHIND);
}

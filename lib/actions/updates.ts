"use server";

import { run, type ActionResult } from "./result";
import { getUpdateInfo, type UpdateInfo } from "@/lib/data/updates";

/** Check the upstream repository for a newer Deplo release. */
export async function checkForUpdatesAction(): Promise<ActionResult<UpdateInfo>> {
  return run(() => getUpdateInfo());
}

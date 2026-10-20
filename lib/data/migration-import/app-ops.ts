import "server-only";

import { blocker, type Note } from "../../migration/note";
import type { NativeOps } from "../../migration/model";
import { DEFAULT_ROLLBACK_KEEP } from "../../types/app";
import { setAppComposeUpArgs, setAppRollbackKeep } from "../apps/settings";
import { setDeployHookEnabled } from "../deploy-hook";

const why = (e: unknown) => (e instanceof Error ? e.message : "refused");

// A new app starts with Deplo's defaults, so only what differs is written.
export async function landNativeOps(
  appId: string,
  ops: NativeOps,
  isCompose: boolean,
  notes: Note[],
): Promise<void> {
  if (isCompose && ops.composeUpArgs)
    try {
      await setAppComposeUpArgs(appId, ops.composeUpArgs);
    } catch (e) {
      notes.push(
        blocker(
          `Its extra compose flags (${ops.composeUpArgs}) did not come across: ${why(e)}. Set them under Settings → Extra compose flags before deploying.`,
        ),
      );
    }
  if (ops.rollbackKeep !== DEFAULT_ROLLBACK_KEEP)
    try {
      await setAppRollbackKeep(appId, ops.rollbackKeep);
    } catch (e) {
      notes.push(
        `It kept ${ops.rollbackKeep} deploys to roll back to, which did not come across (${why(e)}). Set it under Settings → Rollbacks.`,
      );
    }
  if (!ops.deployHook.enabled)
    try {
      await setDeployHookEnabled(appId, false);
    } catch (e) {
      notes.push(
        `Its deploy hook was off on {panel} but is on here (${why(e)}). Turn it off under Settings → Deploy hook.`,
      );
    }
  else if (ops.deployHook.used)
    notes.push(
      "Its deploy hook has a new address here. Copy it from Settings → Deploy hook and give it to whatever called the old one, which still deploys on {panel}.",
    );
}

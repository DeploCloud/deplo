import "server-only";

import { eq } from "drizzle-orm";
import type { DbTx } from "../../db/client";
import {
  appDeplopackInputs,
  appDeplopackInputValues,
} from "../../db/schema/control-plane/apps";
import type { DeplopackOverride } from "../../apps/deplopack-types";

export async function saveDeplopackInputs(
  tx: DbTx,
  appId: string,
  inputs: readonly DeplopackOverride[],
): Promise<void> {
  await tx
    .delete(appDeplopackInputs)
    .where(eq(appDeplopackInputs.appId, appId));
  if (!inputs.length) return;
  await tx
    .insert(appDeplopackInputs)
    .values(
      inputs.map((input) => ({ appId, env: input.env, type: input.type })),
    );
  const values = inputs.flatMap((input) =>
    input.values.map((value, position) => ({
      appId,
      env: input.env,
      position,
      value,
    })),
  );
  if (values.length) await tx.insert(appDeplopackInputValues).values(values);
}

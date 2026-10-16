import { gqlAction } from "@/lib/graphql-client";
import type { BulkEnvItem } from "@/lib/env-bulk";
import type { EnvVarDTO } from "@/lib/types/env";
import type { SharedVarDTO } from "@/lib/data/shared-vars/team-view";

export function standaloneBulkItem(
  row: EnvVarDTO,
  id: string,
  scope?: string,
): BulkEnvItem {
  return {
    ...row,
    id,
    scope,
    remove: () =>
      gqlAction(`mutation($id: String!) { deleteEnv(id: $id) }`, {
        id: row.id,
      }),
    makeSecret:
      row.type === "plain" && !row.masked
        ? () =>
            gqlAction(`mutation($id: String!) { makeEnvSecret(id: $id) }`, {
              id: row.id,
            })
        : undefined,
  };
}

export function sharedBulkItem(row: SharedVarDTO, id = row.id): BulkEnvItem {
  return {
    ...row,
    id,
    remove: row.editable
      ? () =>
          gqlAction(`mutation($id: String!) { deleteSharedVar(id: $id) }`, {
            id: row.id,
          })
      : undefined,
    secretId: row.id,
    makeSecret:
      row.editable && row.type === "plain" && !row.masked
        ? () =>
            gqlAction(
              `mutation($id: String!) { makeSharedVarSecret(id: $id) }`,
              { id: row.id },
            )
        : undefined,
  };
}

export function unlinkBulkItem(
  row: { id: string; key: string; value: string; masked: boolean },
  appId: string,
  id: string,
  scope?: string,
): BulkEnvItem {
  return {
    ...row,
    id,
    scope,
    type: row.masked ? "secret" : "plain",
    remove: () =>
      gqlAction(
        `mutation($varId: String!, $appId: String!, $linked: Boolean!) {
          setSharedVarAppLink(varId: $varId, appId: $appId, linked: $linked)
        }`,
        { varId: row.id, appId, linked: false },
      ),
  };
}

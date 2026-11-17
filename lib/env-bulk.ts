import type { ActionResult } from "./result";

export interface BulkEnvItem {
  id: string;
  key: string;
  scope?: string;
  value?: string;
  masked?: boolean;
  type?: string;
  note?: string | null;
  remove?: () => Promise<ActionResult<unknown>>;
  makeSecret?: () => Promise<ActionResult<unknown>>;
  secretId?: string;
}

export function readableEnvItems(items: BulkEnvItem[]) {
  return items.filter(
    (item) => item.type === "plain" && !item.masked && item.value !== undefined,
  );
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ");

// A scope is a heading with a blank line under it, so pasting the copy back reads only notes as notes.
export function copyEnvItems(items: BulkEnvItem[]): string {
  const out: string[] = [];
  let scope: string | undefined;
  for (const item of readableEnvItems(items)) {
    if (item.scope && item.scope !== scope) {
      if (out.length) out.push("");
      out.push(`# ${oneLine(item.scope)}`, "");
    }
    scope = item.scope ?? scope;
    if (item.note) out.push(`# ${oneLine(item.note)}`);
    out.push(`${item.key}=${JSON.stringify(item.value)}`);
  }
  return out.join("\n");
}

export function retainEnvSelection(
  ids: ReadonlySet<string>,
  visibleIds: string[],
) {
  return new Set(visibleIds.filter((id) => ids.has(id)));
}

export async function runEnvBulk(
  items: BulkEnvItem[],
  action: "remove" | "makeSecret",
) {
  const succeeded: string[] = [];
  const failed: string[] = [];
  const errors: string[] = [];
  const outcomes = new Map<string, ActionResult<unknown>>();
  for (const item of items) {
    const perform = item[action];
    if (!perform) continue;
    const operationId =
      action === "makeSecret" ? (item.secretId ?? item.id) : item.id;
    let result = outcomes.get(operationId);
    if (!result) {
      try {
        result = await perform();
      } catch (error) {
        result = {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : "Could not update variable",
        };
      }
      outcomes.set(operationId, result);
    }
    if (result.ok) succeeded.push(item.id);
    else {
      failed.push(item.id);
      errors.push(`${item.key}: ${result.error}`);
    }
  }
  return { succeeded, failed, errors };
}

const selectionOwners = new Map<string, () => void>();

export function registerEnvSelection(owner: string, clear: () => void) {
  selectionOwners.set(owner, clear);
  return () => {
    selectionOwners.delete(owner);
  };
}

export function claimEnvSelection(owner: string) {
  for (const [id, clear] of selectionOwners) {
    if (id !== owner) clear();
  }
}

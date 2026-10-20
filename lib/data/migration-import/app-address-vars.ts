import "server-only";

import { eq, inArray, sql } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import { requireActiveTeamId } from "../../membership";
import type { SharedRefLevel } from "../../migration/map/env";
import { blocker, type Note } from "../../migration/note";
import { setAppEnv } from "../env";
import { setImportedSharedVarValue } from "../shared-vars/authoring";
import { type SharedIndex, sharedEntry } from "./shared-vars-import";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The whole value, or a URL's host - never a run of characters inside another name.
export function renameHost(value: string, hosts: Map<string, string>): string {
  const whole = hosts.get(value.trim().toLowerCase());
  if (whole) return whole;
  let out = value;
  for (const [from, to] of hosts)
    out = out.replace(
      new RegExp(
        `(//(?:[^/@\\s?#]*@)?)${escape(from)}(?=$|[:/?#\\s"',;])`,
        "gi",
      ),
      (_, lead: string) => lead + to,
    );
  return out;
}

const list = (keys: string[]) => keys.join(", ");
const they = (keys: string[], one: string, many: string) =>
  keys.length === 1 ? one : many;

// Old address -> new one, split by whether the old one still answers on this Deplo, and for whom.
// Another team's address is never named to this one.
async function splitByCarried(rehosted: Map<string, string>) {
  const teamId = await requireActiveTeamId();
  const olds = [...rehosted.keys()].map((h) => h.toLowerCase());
  const held =
    olds.length === 0
      ? []
      : await getDb()
          .select({
            name: sql<string>`lower(${domainsTable.name})`,
            teamId: appsTable.teamId,
          })
          .from(domainsTable)
          .leftJoin(appsTable, eq(appsTable.id, domainsTable.appId))
          .where(inArray(sql`lower(${domainsTable.name})`, olds));
  const ours = new Set(
    held.filter((r) => r.teamId === teamId).map((r) => r.name),
  );
  const theirs = new Set(
    held.filter((r) => r.teamId !== teamId).map((r) => r.name),
  );
  const gone = new Map<string, string>();
  const carried = new Map<string, string>();
  const foreign = new Map<string, string>();
  for (const [from, to] of rehosted) {
    const key = from.toLowerCase();
    (ours.has(key) ? carried : theirs.has(key) ? foreign : gone).set(key, to);
  }
  return { gone, carried, foreign };
}

export async function rehostAppVariables(
  appId: string,
  rehosted: Map<string, string>,
  env: { key: string; value: string }[],
  linked: { key: string; level: SharedRefLevel; sharedKey: string }[],
  shared: SharedIndex,
  notes: Note[],
): Promise<void> {
  if (rehosted.size === 0) return;
  const { gone, carried, foreign } = await splitByCarried(rehosted);
  const names = (value: string, hosts: Map<string, string>) =>
    hosts.size > 0 && renameHost(value, hosts) !== value;
  const named = (value: string) => names(value, carried);
  const elsewhere = (value: string) => names(value, foreign);

  const rewritten = env.map((e) => ({
    key: e.key,
    value: renameHost(e.value, gone),
  }));
  const touched = rewritten
    .filter((r, i) => r.value !== env[i]!.value)
    .map((r) => r.key);
  if (touched.length > 0) {
    try {
      await setAppEnv(appId, rewritten, undefined, { overwriteSecrets: true });
      notes.push(
        `${list(touched)} named the old address, so ${they(touched, "it now names", "they now name")} the new one.`,
      );
    } catch (e) {
      notes.push(
        blocker(
          `${list(touched)} still name the old address, which no longer answers for this app (${
            e instanceof Error ? e.message : "refused"
          }) - set ${they(touched, "it", "them")} to ${list([...gone.values()])} under Variables.`,
        ),
      );
    }
  }

  const movedShared: string[] = [];
  const stuckShared: string[] = [];
  const namedShared: string[] = [];
  const foreignShared: string[] = [];
  for (const r of linked) {
    const entry = sharedEntry(shared, r.level, r.sharedKey);
    if (!entry?.varId) continue;
    const next = renameHost(entry.value, gone);
    if (next === entry.value) {
      if (named(entry.value)) namedShared.push(r.key);
      else if (elsewhere(entry.value)) foreignShared.push(r.key);
      continue;
    }
    if (!entry.created) {
      stuckShared.push(r.key);
      continue;
    }
    try {
      await setImportedSharedVarValue(entry.varId, next);
      entry.value = next;
      movedShared.push(r.key);
    } catch {
      stuckShared.push(r.key);
    }
  }
  if (movedShared.length > 0)
    notes.push(
      `The shared ${they(movedShared, "variable", "variables")} ${list(movedShared)} named this app's old address, so ${they(movedShared, "it now names", "they now name")} the new one, for every app linked to ${they(movedShared, "it", "them")}.`,
    );
  if (stuckShared.length > 0)
    notes.push(
      blocker(
        `${list(stuckShared)} ${they(stuckShared, "reads a shared variable", "read shared variables")} already in this team that still ${they(stuckShared, "names", "name")} this app's old address, which no longer answers here. Other apps may use ${they(stuckShared, "it", "them")}, so ${they(stuckShared, "it was", "they were")} left as ${they(stuckShared, "it is", "they are")} - unlink under Variables and set ${list([...gone.values()])}.`,
      ),
    );

  const namedOwn = env.filter((e) => named(e.value)).map((e) => e.key);
  const stillNamed = [...namedOwn, ...namedShared];
  if (stillNamed.length > 0)
    notes.push(
      `${list(stillNamed)} ${they(stillNamed, "names", "name")} ${list([...carried.keys()])}, which answers for another app here, so ${they(stillNamed, "it was", "they were")} left as ${they(stillNamed, "it is", "they are")}. If this app should use its own address (${list([...carried.values()])}), change ${they(stillNamed, "it", "them")} under Variables.`,
    );

  const namedForeign = [
    ...env.filter((e) => elsewhere(e.value)).map((e) => e.key),
    ...foreignShared,
  ];
  if (namedForeign.length > 0)
    notes.push(
      `${list(namedForeign)} ${they(namedForeign, "names", "name")} an address this Deplo already serves for someone else, so ${they(namedForeign, "it was", "they were")} left as ${they(namedForeign, "it is", "they are")}. If this app should use its own address (${list([...foreign.values()])}), change ${they(namedForeign, "it", "them")} under Variables.`,
    );
}

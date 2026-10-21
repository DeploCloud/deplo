import "server-only";

import { errorMessage } from "../../utils";
import { eq, inArray, sql } from "drizzle-orm";

import { getDb } from "../../db/client";
import { load as loadYaml } from "../../yaml";
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

export interface AddressRules {
  gone: Map<string, string>;
  carried: Map<string, string>;
  foreign: Map<string, string>;
  // The value on the new address, when the old one is not carried.
  rewrite(value: string): string;
  // Names an old address that still answers here, for this team or for another.
  named(value: string): boolean;
  elsewhere(value: string): boolean;
}

export async function addressRules(
  rehosted: Map<string, string>,
): Promise<AddressRules> {
  const { gone, carried, foreign } =
    rehosted.size === 0
      ? { gone: new Map(), carried: new Map(), foreign: new Map() }
      : await splitByCarried(rehosted);
  const names = (value: string, hosts: Map<string, string>) =>
    hosts.size > 0 && renameHost(value, hosts) !== value;
  return {
    gone,
    carried,
    foreign,
    rewrite: (value) => (gone.size > 0 ? renameHost(value, gone) : value),
    named: (value) => names(value, carried),
    elsewhere: (value) => names(value, foreign),
  };
}

// What has to stay as it is: an old address that answers for another app here.
function leftNotes(
  rules: AddressRules,
  named: string[],
  foreign: string[],
  label: string,
  where: string,
): Note[] {
  const notes: Note[] = [];
  if (named.length > 0)
    notes.push(
      `${label}${list(named)} ${they(named, "names", "name")} ${list([...rules.carried.keys()])}, which answers for another app here, so ${they(named, "it was", "they were")} left as ${they(named, "it is", "they are")}. If this app should use its own address (${list([...rules.carried.values()])}), change ${they(named, "it", "them")} under ${where}.`,
    );
  if (foreign.length > 0)
    notes.push(
      `${label}${list(foreign)} ${they(foreign, "names", "name")} an address this Deplo already serves for someone else, so ${they(foreign, "it was", "they were")} left as ${they(foreign, "it is", "they are")}. If this app should use its own address (${list([...rules.foreign.values()])}), change ${they(foreign, "it", "them")} under ${where}.`,
    );
  return notes;
}

// Variables kept outside the app's own (preview, cron job): new values plus the report lines.
export function rehostPairs<T extends { key: string; value: string }>(
  pairs: T[],
  rules: AddressRules,
  label: (keys: string[]) => string,
  where: string,
): { pairs: T[]; notes: Note[] } {
  const out = pairs.map((p) => ({ ...p, value: rules.rewrite(p.value) }));
  const touched = out
    .filter((p, i) => p.value !== pairs[i]!.value)
    .map((p) => p.key);
  const notes: Note[] = [];
  if (touched.length > 0)
    notes.push(
      `${label(touched)}${list(touched)} named the old address, so ${they(touched, "it now names", "they now name")} the new one.`,
    );
  const named = pairs.filter((p) => rules.named(p.value)).map((p) => p.key);
  const foreign = pairs
    .filter((p) => rules.elsewhere(p.value))
    .map((p) => p.key);
  notes.push(
    ...leftNotes(
      rules,
      named,
      foreign,
      named.length + foreign.length > 0 ? label([...named, ...foreign]) : "",
      where,
    ),
  );
  return { pairs: out, notes };
}

export async function rehostAppVariables(
  appId: string,
  rules: AddressRules,
  env: { key: string; value: string }[],
  linked: { key: string; level: SharedRefLevel; sharedKey: string }[],
  shared: SharedIndex,
  notes: Note[],
): Promise<void> {
  const { gone, named, elsewhere } = rules;
  if (gone.size + rules.carried.size + rules.foreign.size === 0) return;

  const rewritten = env.map((e) => ({
    key: e.key,
    value: rules.rewrite(e.value),
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
          `${list(touched)} still name the old address, which no longer answers for this app (${errorMessage(
            e,
            "refused",
          )}) - set ${they(touched, "it", "them")} to ${list([...gone.values()])} under Variables.`,
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
    const next = rules.rewrite(entry.value);
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
  const namedForeign = env.filter((e) => elsewhere(e.value)).map((e) => e.key);
  notes.push(
    ...leftNotes(
      rules,
      [...namedOwn, ...namedShared],
      [...namedForeign, ...foreignShared],
      "",
      "Variables",
    ),
  );
}

// A compose file's own `environment:` values, as `service: KEY` and the value.
function composeValues(yaml: string): { name: string; value: string }[] {
  let doc: unknown;
  try {
    doc = loadYaml(yaml);
  } catch {
    return [];
  }
  const services = (doc as { services?: unknown } | null)?.services;
  if (!services || typeof services !== "object") return [];
  const out: { name: string; value: string }[] = [];
  for (const [svc, def] of Object.entries(services)) {
    const env = (def as { environment?: unknown } | null)?.environment;
    const pairs: [string, unknown][] = Array.isArray(env)
      ? env
          .filter((e): e is string => typeof e === "string" && e.includes("="))
          .map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)])
      : env && typeof env === "object"
        ? Object.entries(env)
        : [];
    for (const [key, value] of pairs)
      if (typeof value === "string")
        out.push({ name: `${svc}: ${key.trim()}`, value });
  }
  return out;
}

// Values written into the compose file stay as written; the report names the ones to change.
export function composeAddressNotes(yaml: string, rules: AddressRules): Note[] {
  if (rules.gone.size + rules.carried.size + rules.foreign.size === 0)
    return [];
  const values = composeValues(yaml);
  const gone = values
    .filter((v) => rules.rewrite(v.value) !== v.value)
    .map((v) => v.name);
  const notes: Note[] = [];
  if (gone.length > 0)
    notes.push(
      blocker(
        `The compose file sets ${list(gone)} to the old address, which no longer answers for this app. Change ${they(gone, "it", "them")} to ${list([...rules.gone.values()])} under Compose.`,
      ),
    );
  notes.push(
    ...leftNotes(
      rules,
      values.filter((v) => rules.named(v.value)).map((v) => v.name),
      values.filter((v) => rules.elsewhere(v.value)).map((v) => v.name),
      "The compose file's ",
      "Compose",
    ),
  );
  return notes;
}

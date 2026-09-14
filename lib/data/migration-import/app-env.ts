import "server-only";

import type { SourceApplication, SourceCompose } from "../../migration/model";
import {
  envNeedsInterpolation,
  parseEnvBlob,
  renameDatabaseHosts,
  resolveSharedRefs,
} from "../../migration/map/env";
import type { SharedIndex } from "./shared-vars-import";

// The app's variables as Deplo stores them, with every note the mapping owes the
// report. `linkable` and `dropped` are what the caller turns into shared-variable
// links once the app exists.
export function mapAppEnv(
  detail: SourceApplication & SourceCompose,
  home: { shared: SharedIndex; dbHosts: Map<string, string> },
  notes: string[],
) {
  // Build args become ordinary variables: that is how Deplo passes values to a build
  // (agent >= 1.9.0), rather than as a second channel.
  const envEntries = parseEnvBlob(detail.env);
  const argEntries = parseEnvBlob(
    (detail as SourceApplication).buildArgs,
  ).filter((a) => !envEntries.some((e) => e.key === a.key));
  const rows = [...envEntries, ...argEntries];

  // A value that is EXACTLY one reference to a shared variable of the SAME name is
  // a link here, not a copy: a link injects (ADR-0012), and it injects under the
  // shared variable's own key, so that is the only reference shape it can express.
  const refs = (detail.sharedRefs ?? []).filter(
    (r) => !argEntries.some((a) => a.key === r.key),
  );
  const linkable = refs.filter(
    (r) => r.whole && r.key === r.sharedKey && home.shared.has(r.sharedKey),
  );
  const dropped = new Map<string, { key: string; value: string }>();
  for (const r of linkable) {
    const i = rows.findIndex((e) => e.key === r.key);
    if (i !== -1) dropped.set(r.key, rows.splice(i, 1)[0]);
  }
  // Whatever is still a reference becomes a VALUE. A no-op on a panel that already
  // answered resolved; the real work on one that resolves at deploy time.
  const refResolved = resolveSharedRefs(
    rows,
    new Map([...home.shared].map(([k, v]) => [k, v.value] as const)),
  );
  // Typed secret ONLY where the panel itself said so: a secret is immutable and
  // a fork's preview drops it, so a guess from the name breaks a working app.
  const secretKeys = new Set(detail.secretEnvKeys ?? []);
  const env = rows.map((e) => ({
    ...e,
    type: secretKeys.has(e.key) ? ("secret" as const) : ("plain" as const),
  }));
  const masked = env.filter((e) => e.type === "secret").map((e) => e.key);
  if (masked.length > 0)
    notes.push(
      `${masked.join(", ")} came across as secrets, as {panel} marked them: write-only here too, and never shown again.`,
    );
  const aliased = refs.filter(
    (r) => r.whole && r.key !== r.sharedKey && home.shared.has(r.sharedKey),
  );
  if (linkable.length > 0)
    notes.push(
      `${linkable.map((r) => r.key).join(", ")} read a shared variable on {panel}, so ${
        linkable.length === 1 ? "it is" : "they are"
      } linked to the shared variable of the same name here instead of carrying a copy. Unlink under Variables to give this app its own value.`,
    );
  if (aliased.length > 0)
    notes.push(
      `${aliased
        .map((r) => `${r.key} read {{${r.level}.${r.sharedKey}}}`)
        .join(
          ", ",
        )}. A link here injects under the shared variable's own name, so it cannot be called something else - the value {panel} resolved came across instead.`,
    );
  if (refResolved.unresolved.length > 0)
    notes.push(
      `${refResolved.unresolved.join(
        ", ",
      )} still read a shared variable {panel} did not answer with the value behind. Put the real values in under Variables.`,
    );
  // The databases this same import renamed, before the app is created.
  const renamed = renameDatabaseHosts(env, home.dbHosts);
  if (renamed.length > 0)
    notes.push(
      `${renamed.join(", ")} named the database by its {panel} hostname, which does not exist here, so ${
        renamed.length === 1 ? "it now names" : "they now name"
      } the one Deplo gave it.`,
    );

  if (argEntries.length > 0)
    notes.push(
      `${argEntries.length} build argument(s) became environment variables - that is how Deplo passes values to a build.`,
    );
  const interpolated = envNeedsInterpolation(env);
  if (interpolated.length > 0)
    notes.push(
      `Deplo does not resolve {panel}'s \`\${{...}}\` templating - put the real values in: ${interpolated.join(", ")}.`,
    );

  return { env, linkable, dropped, secretKeys };
}

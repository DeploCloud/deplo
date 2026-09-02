/**
 * Read a source panel and print what an import would see. READ ONLY: this only
 * ever issues the GETs the scan issues, never a write, and it touches no Deplo
 * database - it exercises `lib/migration/*` alone.
 */

import {
  composeHasHostBindMount,
  composeJoinsForeignNetwork,
  composeNeedsHostPrivileges,
  composePublishesPorts,
  composeUsesExternalMerge,
} from "../lib/deploy/compose-lint";
import {
  deploEngineFor,
  envNeedsInterpolation,
  mapBuildSettings,
  mapDatabase,
  mapDomains,
  mapMounts,
  mapResources,
  mapSource,
  parseEnvBlob,
  mapPorts,
  adaptComposeForDeplo,
  unsupportedNotes,
} from "../lib/migration/map";
import type { DokployDbKind } from "../lib/migration/dokploy/client";
import { normalizeSourceBaseUrl } from "../lib/migration/transport";
import type { SourceCredential } from "../lib/migration/source";
import { isMigrationPlatform, sourceClient } from "../lib/migration/source";
import { detectMigrationSource } from "../lib/migration/detect";
import { SOURCE_DB_KINDS } from "../lib/migration/model";
import type {
  SourceApplication,
  SourceCompose,
  SourceDatabase,
} from "../lib/migration/model";

const [url, apiKey, forced] = process.argv.slice(2);
if (!url || !apiKey) {
  console.error("usage: migration-probe.mts <url> <api-key> [dokploy|coolify]");
  process.exit(1);
}

const baseUrl = normalizeSourceBaseUrl(url);
const kind = isMigrationPlatform(forced)
  ? forced
  : await detectMigrationSource(baseUrl, apiKey);
const c: SourceCredential = { kind, baseUrl, apiKey };
const src = sourceClient(c);

console.log(`platform    ${kind}`);

console.log(`source      ${c.baseUrl}`);
console.log(
  `organization ${(await src.organizationName()) ?? "(not reported)"}`,
);

const servers = await src.listServers().catch(() => []);
console.log(
  `servers      ${servers.length === 0 ? "none (everything is on the panel's own host)" : servers.map((s) => `${s.name} ${s.ipAddress ?? ""}`).join(", ")}`,
);

for (const p of await src.listProjects()) {
  console.log(`\n${p.name}`);
  for (const env of p.environments ?? []) {
    console.log(`  ${env.name}`);
    const stubs: { kind: string; id: string }[] = [
      ...(env.applications ?? []).map((a) => ({
        kind: "application",
        id: a.applicationId,
      })),
      ...(env.compose ?? []).map((s) => ({ kind: "compose", id: s.composeId })),
      ...SOURCE_DB_KINDS.flatMap((kind) =>
        ((env[kind] ?? []) as Record<string, unknown>[])
          .map((row) => ({ kind, id: String(row[`${kind}Id`] ?? "") }))
          .filter((s) => s.id),
      ),
    ];
    for (const stub of stubs) {
      try {
        const detail = (await src.getService(stub.kind, stub.id)) as Record<
          string,
          unknown
        >;
        const name = String(detail.name ?? "").trim() || stub.id;
        const extra =
          stub.kind === "application"
            ? `${detail.sourceType}/${detail.buildType}`
            : stub.kind === "compose"
              ? `${detail.sourceType}`
              : `${detail.dockerImage ?? "?"}`;
        const domains = (detail.domains as unknown[] | undefined)?.length ?? 0;
        const mounts = (detail.mounts as unknown[] | undefined)?.length ?? 0;
        console.log(
          `    ${stub.kind.padEnd(11)} ${name.padEnd(24)} ${String(extra).padEnd(22)} ` +
            `appName=${detail.appName ?? "-"} server=${detail.serverId || "(panel host)"} ` +
            `domains=${domains} mounts=${mounts}`,
        );
        if (process.env.PROBE_MAP) describe(stub.kind, detail, name);
        if (process.env.PROBE_DATA)
          await describeVolumes(stub.kind, stub.id, detail);
      } catch (e) {
        console.log(
          `    ${stub.kind.padEnd(11)} ${stub.id.padEnd(24)} FAILED: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* PROBE_MAP=1: run the real mappers over the real row                  */
/* ------------------------------------------------------------------ */

/** What the import would make of one service. Pure functions only - this writes
 *  nothing anywhere and is the cheapest way to check a mapping against real data. */
function describe(
  kind: string,
  row: Record<string, unknown>,
  name: string,
): void {
  const say = (label: string, value: unknown) =>
    console.log(`        ${label.padEnd(12)} ${value}`);
  const notes: string[] = [];

  if (kind === "application" || kind === "compose") {
    const detail = row as unknown as SourceApplication & SourceCompose;
    const env = parseEnvBlob(detail.env);
    const args = parseEnvBlob(detail.buildArgs).filter(
      (a) => !env.some((e) => e.key === a.key),
    );
    say(
      "env",
      `${env.length} var(s)${args.length ? ` + ${args.length} build arg(s)` : ""}`,
    );
    const interpolated = envNeedsInterpolation([...env, ...args]);
    if (interpolated.length)
      notes.push(`\${{...}} in ${interpolated.join(", ")}`);

    const domains = mapDomains(detail.domains, {
      isCompose: kind === "compose",
    });
    say(
      "domains",
      domains.value.length === 0
        ? "none worth importing"
        : domains.value
            .map(
              (d) =>
                `${d.host}${d.pathPrefix}${d.port ? `:${d.port}` : ""} ${d.certProvider}${d.service ? ` -> ${d.service}` : ""}`,
            )
            .join(" | "),
    );
    notes.push(...domains.notes);

    const mounts = mapMounts(detail.mounts, { isCompose: kind === "compose" });
    say(
      "mounts",
      `${mounts.value.files.length} file(s), ${mounts.value.volumes.length} volume(s)` +
        (mounts.value.volumes.length
          ? ` [${mounts.value.volumes.map((v) => `${v.type}:${v.name}@${v.mountPath}`).join(", ")}]`
          : ""),
    );
    notes.push(...mounts.notes);

    const resources = mapResources(detail);
    if (resources.value) say("resources", JSON.stringify(resources.value));
    notes.push(...resources.notes);

    if (kind === "compose") {
      const yamlText = (detail.composeFile ?? "").trim();
      say(
        "compose",
        yamlText
          ? `${yamlText.length} bytes inline`
          : "IN A GIT REPO (fetched at import)",
      );
      if (yamlText) {
        const adapted = adaptComposeForDeplo(yamlText);
        say(
          "rewrites",
          adapted.changes.length ? adapted.changes.join(" ") : "none needed",
        );
        const gates: string[] = [];
        if (composeUsesExternalMerge(adapted.compose))
          gates.push("extends/include (REFUSED)");
        if (composePublishesPorts(adapted.compose))
          gates.push("publishes ports (grant)");
        if (composeHasHostBindMount(adapted.compose))
          gates.push("host bind mount (grant)");
        if (composeNeedsHostPrivileges(adapted.compose))
          gates.push("host privileges (grant)");
        if (composeJoinsForeignNetwork(adapted.compose))
          gates.push("foreign network (grant)");
        say("gates", gates.length ? gates.join(", ") : "clean");
      }
    } else {
      const source = mapSource(detail);
      say(
        "source",
        source.value.kind === "git"
          ? `git ${source.value.repo.repo}@${source.value.repo.branch}`
          : source.value.kind === "docker-image"
            ? `image ${source.value.image}`
            : "NOT IMPORTABLE (lands as an upload)",
      );
      notes.push(...source.notes);
      const build = mapBuildSettings(detail);
      say("build", JSON.stringify(build.value));
      notes.push(
        ...build.notes,
        ...mapPorts(detail).notes,
        ...unsupportedNotes(detail),
      );
    }
  } else {
    const engine = deploEngineFor(kind as DokployDbKind);
    if (!engine) {
      say("engine", `NO DEPLO EQUIVALENT (${kind})`);
      return;
    }
    const mapped = mapDatabase(kind as DokployDbKind, {
      ...(row as unknown as SourceDatabase),
      name,
    });
    if (mapped.value)
      say(
        "database",
        `${mapped.value.type}:${mapped.value.version ?? "(default)"} user=${mapped.value.username} db=${mapped.value.dbName} port=${mapped.value.exposedPort ?? "-"}${mapped.value.customImage ? ` image=${mapped.value.customImage}` : ""}`,
      );
    notes.push(...mapped.notes);
  }

  for (const n of notes) console.log(`        note         ${n}`);
}

/* ------------------------------------------------------------------ */
/* PROBE_DATA=1: what the cutover would find                            */
/* ------------------------------------------------------------------ */

/**
 * What the cutover would find: what the service mounts, and whether it is still
 * up. Asked through the same client the cutover uses, so it is the same answer.
 */
async function describeVolumes(
  kind: string,
  id: string,
  detail: Record<string, unknown>,
): Promise<void> {
  const state = await src
    .serviceRuntime({
      kind,
      id,
      appName: String(detail.appName ?? detail.name ?? id),
      declaredVolumes: [],
      declaredBindMounts: [],
      composeFile:
        typeof detail.composeFile === "string" ? detail.composeFile : null,
    })
    .catch((e: unknown) => {
      console.log(
        `        volumes      could not be read: ${e instanceof Error ? e.message : e}`,
      );
      return null;
    });
  if (!state) return;
  console.log(`        running      ${state.running}`);
  for (const v of state.volumes)
    console.log(`        volume       ${v.name} @ ${v.mountPath}`);
  for (const m of state.hostMounts)
    console.log(`        host path    ${m.hostPath} @ ${m.mountPath}`);
  for (const n of state.notes) console.log(`        note         ${n}`);
}

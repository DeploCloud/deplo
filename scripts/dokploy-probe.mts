/**
 * Read a Dokploy instance and print what an import would see. READ ONLY: this
 * only ever issues the GETs the scan issues, never a write, and it touches no
 * Deplo database - it exercises `lib/dokploy/*` alone.
 *
 *   node --import tsx scripts/dokploy-probe.mts <url> <api-key>
 *
 * Kept because the shapes this thing prints are the whole reason the importer is
 * written the way it is: `project.all` is a PROJECTION (an application arrives as
 * {applicationId, name, applicationStatus}, a database as {postgresId} and nothing
 * else), so anything authoritative has to come from the per-service detail call.
 * When an instance behaves unexpectedly, run this first.
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
  sourceVolumesFrom,
  envNeedsInterpolation,
  mapBuildSettings,
  mapDatabase,
  mapDomains,
  mapMounts,
  mapResources,
  mapSource,
  parseEnvBlob,
  portNotes,
  adaptComposeForDeplo,
  unsupportedNotes,
} from "../lib/dokploy/map";
import type {
  DokployApplication,
  DokployCompose,
  DokployDatabase,
  DokployDbKind,
} from "../lib/dokploy/client";
import {
  DOKPLOY_DB_KINDS,
  activeOrganizationName,
  getService,
  inspectContainer,
  listAppContainers,
  listProjects,
  listServers,
  normalizeDokployBaseUrl,
  serviceDisplayName,
  type DokployCredential,
  type DokployRuntime,
} from "../lib/dokploy/client";

const [url, apiKey] = process.argv.slice(2);
if (!url || !apiKey) {
  console.error("usage: dokploy-probe.mts <url> <api-key>");
  process.exit(1);
}

const c: DokployCredential = { baseUrl: normalizeDokployBaseUrl(url), apiKey };

console.log(`source      ${c.baseUrl}`);
console.log(`organization ${(await activeOrganizationName(c)) ?? "(not reported)"}`);

const servers = await listServers(c).catch(() => []);
console.log(
  `servers      ${servers.length === 0 ? "none (everything is on the Dokploy host)" : servers.map((s) => `${s.name} ${s.ipAddress ?? ""}`).join(", ")}`,
);

for (const p of await listProjects(c)) {
  console.log(`\n${p.name}`);
  for (const env of p.environments ?? []) {
    console.log(`  ${env.name}`);
    const stubs: { kind: string; id: string }[] = [
      ...(env.applications ?? []).map((a) => ({
        kind: "application",
        id: a.applicationId,
      })),
      ...(env.compose ?? []).map((s) => ({ kind: "compose", id: s.composeId })),
      ...DOKPLOY_DB_KINDS.flatMap((kind) =>
        ((env[kind] ?? []) as Record<string, unknown>[])
          .map((row) => ({ kind, id: String(row[`${kind}Id`] ?? "") }))
          .filter((s) => s.id),
      ),
    ];
    for (const stub of stubs) {
      try {
        const detail = (await getService(c, stub.kind, stub.id)) as Record<
          string,
          unknown
        >;
        const name = serviceDisplayName(detail, stub.id);
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
            `appName=${detail.appName ?? "-"} server=${detail.serverId ?? "(dokploy host)"} ` +
            `domains=${domains} mounts=${mounts}`,
        );
        if (process.env.PROBE_MAP) describe(stub.kind, detail, name);
        if (process.env.PROBE_DATA) await describeVolumes(stub.kind, detail);
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
function describe(kind: string, row: Record<string, unknown>, name: string): void {
  const say = (label: string, value: unknown) =>
    console.log(`        ${label.padEnd(12)} ${value}`);
  const notes: string[] = [];

  if (kind === "application" || kind === "compose") {
    const detail = row as unknown as DokployApplication & DokployCompose;
    const env = parseEnvBlob(detail.env);
    const args = parseEnvBlob(detail.buildArgs).filter(
      (a) => !env.some((e) => e.key === a.key),
    );
    say("env", `${env.length} var(s)${args.length ? ` + ${args.length} build arg(s)` : ""}`);
    const interpolated = envNeedsInterpolation([...env, ...args]);
    if (interpolated.length) notes.push(`\${{...}} in ${interpolated.join(", ")}`);

    const domains = mapDomains(detail.domains, { isCompose: kind === "compose" });
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
      say("compose", yamlText ? `${yamlText.length} bytes inline` : "IN A GIT REPO (fetched at import)");
      if (yamlText) {
        const adapted = adaptComposeForDeplo(yamlText);
        say("rewrites", adapted.changes.length ? adapted.changes.join(" ") : "none needed");
        const gates: string[] = [];
        if (composeUsesExternalMerge(adapted.compose)) gates.push("extends/include (REFUSED)");
        if (composePublishesPorts(adapted.compose)) gates.push("publishes ports (grant)");
        if (composeHasHostBindMount(adapted.compose)) gates.push("host bind mount (grant)");
        if (composeNeedsHostPrivileges(adapted.compose)) gates.push("host privileges (grant)");
        if (composeJoinsForeignNetwork(adapted.compose)) gates.push("foreign network (grant)");
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
      notes.push(...build.notes, ...portNotes(detail), ...unsupportedNotes(detail));
    }
  } else {
    const engine = deploEngineFor(kind as DokployDbKind);
    if (!engine) {
      say("engine", `NO DEPLO EQUIVALENT (${kind})`);
      return;
    }
    const mapped = mapDatabase(kind as DokployDbKind, {
      ...(row as unknown as DokployDatabase),
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
 * The containers of a service and the volumes they mount — the discovery half of
 * a data cutover, run without moving anything.
 */
async function describeVolumes(
  kind: string,
  detail: Record<string, unknown>,
): Promise<void> {
  const appName = String(detail.appName ?? "");
  if (!appName) return;
  const order: DokployRuntime[] =
    kind === "compose" ? ["standalone", "swarm"] : ["swarm", "standalone"];
  let containers: { containerId: string; name: string; state: string }[] = [];
  let found: DokployRuntime | null = null;
  for (const type of order) {
    containers = await listAppContainers(c, appName, type).catch(() => []);
    if (containers.length > 0) {
      found = type;
      break;
    }
  }
  if (containers.length === 0) {
    console.log("        volumes      no container running - nothing to read");
    return;
  }
  console.log(`        containers   ${containers.length} (${found})`);
  for (const ct of containers) {
    const info = await inspectContainer(c, ct.containerId).catch(() => null);
    if (!info) continue;
    for (const v of sourceVolumesFrom(info))
      console.log(`        volume       ${v.name} @ ${v.mountPath}`);
  }
}

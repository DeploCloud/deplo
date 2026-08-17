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
  DOKPLOY_DB_KINDS,
  activeOrganizationName,
  getService,
  listProjects,
  listServers,
  normalizeDokployBaseUrl,
  serviceDisplayName,
  type DokployCredential,
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
      } catch (e) {
        console.log(
          `    ${stub.kind.padEnd(11)} ${stub.id.padEnd(24)} FAILED: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
  }
}

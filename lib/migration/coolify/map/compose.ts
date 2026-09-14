import yaml from "../../../yaml";
import {
  composeServiceExposingPort,
  composeServices,
} from "../../map/compose-read";
import { deploFilesPath } from "../../map/source-platform";
import type { SourceCompose, SourceMount } from "../../model";
import type { CoolifyApplication, CoolifyService } from "../client";
import { coolifyFallbackPort } from "./applications";
import { coolifyServiceFqdns, parseCoolifyFqdns } from "./domains";
import type { CoolifyExtras } from "./extras";
import { coolifyGitUrl } from "./git-source";
import { coolifyNotes } from "./platform-notes";

/**
 * What each config file is CALLED beside the compose that mounts it, by its
 * container path. Coolify names only that path, and its basename differs:
 * `./filebrowser.json:/.filebrowser.json` bound a DIRECTORY Docker created empty.
 */
function fileNamesFromCompose(compose: string | null): Map<string, string> {
  const out = new Map<string, string>();
  let doc: { services?: Record<string, { volumes?: unknown }> } | null;
  try {
    doc = yaml.load(compose ?? "") as typeof doc;
  } catch {
    return out;
  }
  for (const svc of Object.values(doc?.services ?? {})) {
    if (!Array.isArray(svc?.volumes)) continue;
    for (const v of svc.volumes) {
      const raw =
        typeof v === "string"
          ? { source: v.split(":")[0], target: v.split(":")[1] }
          : v && typeof v === "object"
            ? (v as { source?: string; target?: string })
            : null;
      const source = raw?.source?.trim();
      const target = raw?.target?.trim();
      if (!source || !target?.startsWith("/")) continue;
      // Either spelling of the same file: the author's `./x`, and the absolute
      // path under the panel's own data directory that its rendered copy uses.
      const rel = deploFilesPath(source) ?? source;
      if (!/^\.\//.test(rel)) continue;
      const name = rel.replace(/^\.\/+/, "").replace(/\/+$/, "");
      if (name) out.set(target.replace(/\/+$/, ""), name);
    }
  }
  return out;
}

/**
 * A `dockercompose` application, or a Coolify SERVICE (a one-click template), as
 * a compose stack. The RAW file is the one the author wrote; the parsed one is
 * Coolify's copy, with its own labels, network and container names baked in.
 */
export function coolifyCompose(
  row: CoolifyApplication | CoolifyService,
  extras: CoolifyExtras = {},
): { value: SourceCompose; notes: string[] } {
  const notes: string[] = [];
  // Kept byte for byte: the file is the author's, and a trim is still an edit.
  const raw = row.docker_compose_raw?.trim() ? row.docker_compose_raw : null;
  const parsed = row.docker_compose?.trim() ? row.docker_compose : null;
  if (!raw && parsed)
    notes.push(
      "The compose file that came across is {panel}'s rendered copy, not the one you wrote - read it before deploying.",
    );
  const app = row as CoolifyApplication;
  // A SERVICE has no `fqdn` column: its address lives in SERVICE_FQDN_*.
  const magic = coolifyServiceFqdns(extras.env, composeServices(raw ?? parsed));
  // A `dockercompose` APPLICATION keeps its address on the application row, so it
  // names neither a compose service nor a port - and a stack route needs both, or
  // Deplo renders no router at all and the stack answers 404. `ports_exposes` is
  // the port; the one service that exposes one is the service.
  const onCompose = {
    service: composeServiceExposingPort(raw ?? parsed),
    port: coolifyFallbackPort(app),
  };
  const domains = parseCoolifyFqdns(
    app.fqdn,
    app.docker_compose_domains,
    magic,
    onCompose,
  );
  if (app.fqdn?.trim() && onCompose.service)
    notes.push(
      `{panel} kept this stack's address on the application rather than on a service, so Deplo routes it to "${onCompose.service}"${onCompose.port ? ` on port ${onCompose.port}` : ""} - the only one that exposes a port. Change it under Domains if that is the wrong container.`,
    );
  return {
    value: {
      composeId: row.uuid,
      sharedRefs: extras.sharedRefs ?? null,
      secretEnvKeys: extras.secretEnvKeys ?? null,
      platformNotes: [
        ...notes,
        ...coolifyNotes(app),
        ...domains.notes,
        ...(extras.envNotes ?? []),
      ],
      name: row.name ?? null,
      appName: row.name ?? null,
      description: row.description ?? null,
      env: extras.env ?? null,
      composeFile: raw || parsed || null,
      icon: null,
      composeType: "docker-compose",
      stackDir: extras.stackDir ?? null,
      routingPort: onCompose.port,
      // A compose build pack pointed at a repository builds from it: without the
      // repository a `build:` stack arrives with nothing to build from.
      ...(app.git_repository?.trim()
        ? {
            // Like an application: the source it sat behind is what asks for a
            // credential here, and plain git asks for none.
            sourceType: coolifyGitUrl(app).origin,
            customGitUrl: coolifyGitUrl(app).url,
            customGitBranch: app.git_branch ?? null,
            composePath: app.docker_compose_location ?? null,
          }
        : { sourceType: "raw" as const }),
      serverId: extras.serverId ?? "",
      environmentId: extras.environmentId ?? null,
      domains: domains.value,
      mounts: withComposeFileNames(extras.mounts ?? [], raw ?? parsed),
    },
    notes,
  };
}

/** Config files renamed to what their own compose binds. See {@link fileNamesFromCompose}. */
function withComposeFileNames(
  mounts: SourceMount[],
  compose: string | null,
): SourceMount[] {
  const names = fileNamesFromCompose(compose);
  if (names.size === 0) return mounts;
  return mounts.map((m) => {
    if (m.type !== "file") return m;
    const named = names.get((m.mountPath ?? "").trim().replace(/\/+$/, ""));
    return named && named !== m.filePath ? { ...m, filePath: named } : m;
  });
}

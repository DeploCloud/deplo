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
      const rel = deploFilesPath(source) ?? source;
      if (!/^\.\//.test(rel)) continue;
      const name = rel.replace(/^\.\/+/, "").replace(/\/+$/, "");
      if (name) out.set(target.replace(/\/+$/, ""), name);
    }
  }
  return out;
}

export function coolifyCompose(
  row: CoolifyApplication | CoolifyService,
  extras: CoolifyExtras = {},
): { value: SourceCompose; notes: string[] } {
  const notes: string[] = [];
  const raw = row.docker_compose_raw?.trim() ? row.docker_compose_raw : null;
  const parsed = row.docker_compose?.trim() ? row.docker_compose : null;
  if (!raw && parsed)
    notes.push(
      "The compose file that came across is {panel}'s rendered copy, not the one you wrote - read it before deploying.",
    );
  const app = row as CoolifyApplication;
  // A one-click service has no fqdn column at all: its address lives in the SERVICE_FQDN_* variables.
  const magic = coolifyServiceFqdns(extras.env, composeServices(raw ?? parsed));
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
      ...(app.git_repository?.trim()
        ? {
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

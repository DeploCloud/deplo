import "server-only";

import { mapLimit } from "../../utils";

import { serviceDisplayName } from "../../migration/dokploy/client";
import { sourceClient } from "../../migration/source";
import type { SourceCredential } from "../../migration/source";
import { SOURCE_DB_KINDS } from "../../migration/model";
import type {
  HostMount,
  NamedVolume,
  SourceDatabase,
} from "../../migration/model";
import {
  declaredSourceBindMounts,
  declaredSourceVolumes,
} from "../../migration/map/volume-discovery";

export interface SourceService {
  kind: string;
  id: string;
  name: string;
  appName: string;
  serverId: string;
  projectName: string;
  environmentName: string;
  declaredVolumes: NamedVolume[];
  declaredBindMounts: HostMount[];
  composeFile: string | null;
}

export async function sourceServices(
  c: SourceCredential,
): Promise<SourceService[]> {
  const stubs: {
    kind: string;
    id: string;
    projectName: string;
    environmentName: string;
  }[] = [];
  for (const p of await sourceClient(c).listProjects())
    for (const env of p.environments ?? []) {
      const where = {
        projectName: p.name ?? "",
        environmentName: env.name ?? "",
      };
      for (const a of env.applications ?? [])
        stubs.push({ kind: "application", id: a.applicationId, ...where });
      for (const s of env.compose ?? [])
        stubs.push({ kind: "compose", id: s.composeId, ...where });
      for (const kind of SOURCE_DB_KINDS)
        for (const row of (env[kind] ?? []) as SourceDatabase[]) {
          const id = row[`${kind}Id`];
          if (typeof id === "string") stubs.push({ kind, id, ...where });
        }
    }

  const out: (SourceService | null)[] = new Array(stubs.length).fill(null);
  await mapLimit(
    stubs.map((stub, index) => ({ stub, index })),
    5,
    async ({ stub, index }) => {
      const detail = await sourceClient(c)
        .getService(stub.kind, stub.id)
        .catch(() => null);
      if (!detail) return;
      const appName = detail.appName?.trim() ?? "";
      const inline =
        "composeFile" in detail
          ? ((detail as { composeFile?: string | null }).composeFile ?? null)
          : null;
      const composeFile =
        stub.kind === "compose" && !inline?.trim()
          ? await sourceClient(c)
              .getResolvedCompose(stub.id)
              .catch(() => null)
          : inline;
      out[index] = {
        ...stub,
        name: serviceDisplayName(detail, stub.id),
        appName,
        serverId: detail.serverId ?? "",
        declaredVolumes: declaredSourceVolumes({
          kind: stub.kind,
          appName,
          mounts: detail.mounts,
          composeFile,
        }),
        declaredBindMounts: declaredSourceBindMounts(
          detail.mounts,
          composeFile,
          (detail as { stackDir?: string | null }).stackDir ?? null,
        ),
        composeFile,
      };
    },
  );
  return out.filter((s): s is SourceService => s != null);
}

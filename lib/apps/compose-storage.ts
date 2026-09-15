import { stackFilesDir } from "../deploy/deploy-key";
import { looksLikeFileMount } from "../deploy/file-binds";
import {
  composeHostMounts,
  composeVolumeMounts,
} from "../migration/map/volume-discovery";
import { usesComposeStack } from "../utils";

export interface ComposeMount {
  kind: "named" | "host" | "app";
  source: string;
  mountPath: string;
}

export function composeDeclaredMounts(app: {
  slug: string;
  source: string;
  compose: string | null;
  repo: unknown | null;
  dockerImage: string | null;
}): ComposeMount[] {
  if (!usesComposeStack(app)) return [];
  const compose = app.compose ?? "";
  const filesDir = stackFilesDir(app.slug);
  return [
    ...composeVolumeMounts(compose).map((v) => ({
      kind: "named" as const,
      source: v.name,
      mountPath: v.mountPath,
    })),
    ...composeHostMounts(compose, filesDir).map((m) =>
      m.stackRelative && looksLikeFileMount(m.hostPath, m.mountPath)
        ? {
            kind: "app" as const,
            source: "./" + m.hostPath.slice(filesDir.length + 1),
            mountPath: m.mountPath,
          }
        : { kind: "host" as const, source: m.hostPath, mountPath: m.mountPath },
    ),
  ];
}

import { stackFilesDir } from "../deploy/deploy-key";
import { looksLikeFileMount } from "../deploy/file-binds";
import {
  composeHostMounts,
  composeVolumeMounts,
} from "../migration/map/volume-discovery";
import { usesComposeStack } from "../utils";

// ComposeMount is one mount a compose stack declares in its own yaml.
export interface ComposeMount {
  kind: "named" | "host" | "app";
  source: string;
  mountPath: string;
}

// composeDeclaredMounts is what an app's own compose file mounts, empty for other sources.
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

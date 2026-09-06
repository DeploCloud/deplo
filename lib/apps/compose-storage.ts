import { stackFilesDir } from "../deploy/deploy-key";
import { looksLikeFileMount } from "../deploy/file-binds";
import { composeHostMounts, composeVolumeMounts } from "../migration/map";
import { usesComposeStack } from "../utils";

/** One mount a compose stack declares in its OWN yaml - shown, never edited here. */
export interface ComposeMount {
  /** "named" = a compose `volumes:` alias, "app" = a `./x` file of the app's
   *  Files, "host" = a bind of a server folder. */
  kind: "named" | "host" | "app";
  /** The volume's alias, the `./x` path, or the host path the bind shares. */
  source: string;
  /** Where the container sees it. */
  mountPath: string;
}

/**
 * What an app's own compose file mounts. Empty for every other source: only a
 * compose stack ships yaml Deplo deploys verbatim.
 */
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
    // A `./x` source resolves to the stack's own directory, the same rewrite the
    // renderer applies. A file-shaped one is what the deploy creates as a File.
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

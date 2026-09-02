import { stackFilesDir } from "../deploy/deploy-key";
import { composeHostMounts, composeVolumeMounts } from "../migration/map";
import { usesComposeStack } from "../utils";

/** One mount a compose stack declares in its OWN yaml - shown, never edited here. */
export interface ComposeMount {
  /** "named" = a compose `volumes:` alias, "host" = a bind of a server folder. */
  kind: "named" | "host";
  /** The volume's alias, or the host path the bind shares. */
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
  return [
    ...composeVolumeMounts(compose).map((v) => ({
      kind: "named" as const,
      source: v.name,
      mountPath: v.mountPath,
    })),
    // A `./x` source resolves to the stack's own directory, the same rewrite the
    // renderer applies, so the row names where the data really is.
    ...composeHostMounts(compose, stackFilesDir(app.slug)).map((m) => ({
      kind: "host" as const,
      source: m.hostPath,
      mountPath: m.mountPath,
    })),
  ];
}

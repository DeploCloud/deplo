import { normalizeBuildMethod } from "@/lib/frameworks";

const SETTING_KEYS = [
  "dockerfilePath",
  "dockerContextPath",
  "dockerBuildStage",
  "composeFile",
  "staticSinglePageApp",
];

export function remapBuildInput(build: unknown): Record<string, unknown> {
  const { settings, rootDir, outputDir, buildMethod, ...rest } = (build ??
    {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...rest };
  if (buildMethod != null) Object.assign(out, methodInput(buildMethod));
  // Keys of a retired builder (railpackVersion, nixpacksPublishDirectory) are dropped, not stored.
  if (settings != null && typeof settings === "object")
    out.methodSettings = Object.fromEntries(
      Object.entries(settings).filter(([k]) => SETTING_KEYS.includes(k)),
    );
  if (rootDir !== undefined) out.rootDirectory = rootDir;
  if (outputDir !== undefined) out.outputDirectory = outputDir;
  return out;
}

function methodInput(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string" && raw.trim().toLowerCase() === "auto")
    return { methodAuto: true };
  const method = normalizeBuildMethod(typeof raw === "string" ? raw : null);
  if (!method)
    throw new Error(
      `Unknown build method "${String(raw)}". Use auto, railpack, dockerfile or compose.`,
    );
  return { buildMethod: method, methodAuto: false };
}

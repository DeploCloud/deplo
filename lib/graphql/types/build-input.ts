// remapBuildInput translates a GraphQL BuildConfigInput into the stored BuildConfig shape.
export function remapBuildInput(build: unknown): Record<string, unknown> {
  const { settings, rootDir, outputDir, ...rest } = (build ?? {}) as Record<
    string,
    unknown
  >;
  const out: Record<string, unknown> = { ...rest };
  if (settings !== undefined) out.methodSettings = settings;
  if (rootDir !== undefined) out.rootDirectory = rootDir;
  if (outputDir !== undefined) out.outputDirectory = outputDir;
  return out;
}

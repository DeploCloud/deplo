/**
 * Translate a `BuildConfigInput` (GraphQL) into the stored {@link BuildConfig}
 * shape. Three input fields are named differently from the persisted config and
 * MUST be re-keyed, or the shallow merge in `updateServiceBuild` / `createService`
 * (which keys off the BuildConfig names) never sees them and silently keeps the
 * old value:
 *   - `settings`  → `methodSettings` (the JSON method-settings blob)
 *   - `rootDir`   → `rootDirectory`
 *   - `outputDir` → `outputDirectory`
 *
 * Each is re-keyed only when present, so a partial input still changes only the
 * fields it carries (an omitted field stays absent → the merge preserves the
 * stored value). Missing the `rootDir`/`outputDir` remap is why editing Root
 * Directory / Output Directory in build settings appeared not to save: the edit
 * reached the resolver under a key the store never reads, so it reverted to the
 * stored value on reload.
 *
 * Dependency-free (no `builder`/DB imports) so it is unit-testable in isolation,
 * without the GraphQL schema or a database connection.
 */
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

import "server-only";

// Read at CALL time, never captured in a module const: one test worker runs many
// files and restores the env after each, so a captured copy hands a later file
// the dir an earlier one set - or the production default.
export function dataDir(): string {
  return process.env.DEPLO_DATA_DIR || "/data";
}

import jsyaml from "js-yaml";
import {
  parse as parseYaml,
  parseDocument as parseYamlDocument,
  YAMLParseError,
  type Document,
} from "yaml";

export { isMap, isScalar, isSeq, visit, Scalar } from "yaml";
export type { Document, YAMLMap, YAMLSeq } from "yaml";

/**
 * The one YAML seam. READING is `yaml`, not js-yaml, for two things js-yaml gets
 * wrong on a compose file somebody wrote by hand: it refuses an explicitly tagged
 * merge key (`!!merge <<:`, the idiom of every large stack) and it turns a bare
 * `2026-01-01` into a Date, which comes back out as a timestamp.
 */
const READ = { merge: true, logLevel: "error" } as const;

/**
 * js-yaml's error shape, which the callers already read: a `.mark` with 0-based
 * line/column, and a message that does not repeat the position.
 */
function asLoadError(e: unknown): unknown {
  if (!(e instanceof YAMLParseError)) return e;
  const at = e.linePos?.[0];
  const err: Error & { mark?: { line: number; column: number } } = new Error(
    e.message.replace(/ at line \d+, column \d+:[\s\S]*$/, ""),
  );
  if (at) err.mark = { line: at.line - 1, column: at.col - 1 };
  return err;
}

export function load(src: string): unknown {
  try {
    return parseYaml(src, READ);
  } catch (e) {
    throw asLoadError(e);
  }
}

/**
 * The document itself: anchors, merge keys, comments and layout kept, so a rewrite
 * can hand the file back as its author wrote it.
 */
export function parseDocument(src: string): Document {
  return parseYamlDocument(src, READ);
}

export const dump = jsyaml.dump;

const yaml = { load, dump, parseDocument };
export default yaml;

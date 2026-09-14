import jsyaml from "js-yaml";
import {
  parse as parseYaml,
  parseDocument as parseYamlDocument,
  YAMLParseError,
  type Document,
} from "yaml";

export { isMap, isScalar, isSeq, visit, Scalar } from "yaml";
export type { Document, YAMLMap, YAMLSeq } from "yaml";

// Reads go through `yaml`: js-yaml refuses a tagged `!!merge <<:` and turns a bare date into a Date.
const READ = { merge: true, logLevel: "error" } as const;

// Callers already read js-yaml's error shape: a `.mark` with 0-based line/column.
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

// parseDocument keeps anchors, merge keys, comments and layout, so a rewrite stays faithful.
export function parseDocument(src: string): Document {
  return parseYamlDocument(src, READ);
}

export const dump = jsyaml.dump;

const yaml = { load, dump, parseDocument };
export default yaml;

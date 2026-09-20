import { dump } from "js-yaml";
import {
  parse as parseYaml,
  parseDocument as parseYamlDocument,
  YAMLParseError,
  type Document,
} from "yaml";

export { isMap, isScalar, isSeq, visit, Scalar } from "yaml";
export type { Document, YAMLMap, YAMLSeq } from "yaml";

const READ = { merge: true, logLevel: "error" } as const;

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

export function parseDocument(src: string): Document {
  return parseYamlDocument(src, READ);
}

export { dump };

const yaml = { load, dump, parseDocument };
export default yaml;

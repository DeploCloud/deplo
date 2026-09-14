import yaml, {
  isMap,
  isScalar,
  isSeq,
  Scalar,
  type Document,
  type YAMLMap,
} from "../../yaml";

import { keepAuthoredEnvText } from "../../deploy/compose-lint/document";

/** readComposeDoc parses a compose document worth rewriting: it parsed, and its
 *  root is a mapping. */
export function readComposeDoc(source: string): Document | null {
  let doc: Document;
  try {
    doc = yaml.parseDocument(source);
  } catch {
    return null;
  }
  if (doc.errors.length > 0 || !isMap(doc.contents)) return null;
  // Re-serializing the document is what loses `UMASK: 022`, so the text is pinned
  // before anything edits it.
  keepAuthoredEnvText(doc);
  return doc;
}

/** toPlain reads a node as plain data, for the readers that want the value and
 *  not the node. */
export function toPlain(node: unknown): unknown {
  try {
    return (node as { toJSON?: () => unknown } | null)?.toJSON?.() ?? node;
  } catch {
    return null;
  }
}

/** The Scalar node at `map[key]`, when it holds a string. Its `value` is editable
 *  in place, which is what keeps the rest of the file exactly as it was written. */
export function stringScalar(map: YAMLMap, key: string): Scalar | null {
  const node = map.get(key, true);
  return isScalar(node) && typeof node.value === "string" ? node : null;
}

/**
 * The maps a compose file writes a SERVICE's keys into: the services themselves,
 * and the top-level `x-*` blocks the services merge from. An anchor is where the
 * value really lives, so a rewrite that skips it edits a copy.
 */
export function serviceLikeMaps(
  root: YAMLMap,
): { name: string; map: YAMLMap }[] {
  const out: { name: string; map: YAMLMap }[] = [];
  const services = root.get("services");
  if (isMap(services))
    for (const item of services.items)
      if (isMap(item.value))
        out.push({
          name: String((item.key as Scalar).value),
          map: item.value,
        });
  for (const item of root.items) {
    const name = String((item.key as Scalar | null)?.value ?? "");
    if (name.startsWith("x-") && isMap(item.value))
      out.push({ name, map: item.value });
  }
  return out;
}

/** Every `env_file` entry of one service-like map, in all three shapes. */
export function envFileScalars(holder: YAMLMap): Scalar[] {
  const out: Scalar[] = [];
  const node = holder.get("env_file", true);
  if (isScalar(node) && typeof node.value === "string") out.push(node);
  else if (isSeq(node))
    for (const entry of node.items) {
      if (isScalar(entry) && typeof entry.value === "string") out.push(entry);
      else if (isMap(entry)) {
        const path = stringScalar(entry, "path");
        if (path) out.push(path);
      }
    }
  return out;
}

// No CodeMirror imports here: editor-language.test.ts runs under `node --test`.
export type EditorLanguage = "yaml";

// YamlScalarKind - what a YAML plain (unquoted) scalar is, since the parser tags them alike.
export type YamlScalarKind = "number" | "constant" | "string";

const YAML_NUMBER =
  /^[-+]?(?:\d[\d_]*(?:\.[\d_]*)?|\.[\d_]+)(?:[eE][-+]?\d+)?$/;
const YAML_RADIX_NUMBER = /^[-+]?0(?:x[0-9a-fA-F_]+|o[0-7_]+|b[01_]+)$/;
const YAML_SPECIAL_NUMBER = /^[-+]?\.(?:inf|nan)$/i;
const YAML_CONSTANT = /^(?:true|false|yes|no|on|off|null|~)$/i;

// classifyYamlScalar - `@lezer/yaml` tags every plain scalar `content`, so only the text is left to read.
export function classifyYamlScalar(text: string): YamlScalarKind {
  const value = text.trim();
  // An empty value is YAML's null.
  if (value === "") return "constant";
  if (YAML_CONSTANT.test(value)) return "constant";
  if (
    YAML_NUMBER.test(value) ||
    YAML_RADIX_NUMBER.test(value) ||
    YAML_SPECIAL_NUMBER.test(value)
  ) {
    return "number";
  }
  return "string";
}

// languageForPath - the editor language for a file path, or null to keep it plain text.
export function languageForPath(
  path: string | null | undefined,
): EditorLanguage | null {
  if (!path) return null;
  const lower = path.toLowerCase();
  return lower.endsWith(".yml") || lower.endsWith(".yaml") ? "yaml" : null;
}

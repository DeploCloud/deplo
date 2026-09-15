export type EditorLanguage = "yaml";

export type YamlScalarKind = "number" | "constant" | "string";

const YAML_NUMBER =
  /^[-+]?(?:\d[\d_]*(?:\.[\d_]*)?|\.[\d_]+)(?:[eE][-+]?\d+)?$/;
const YAML_RADIX_NUMBER = /^[-+]?0(?:x[0-9a-fA-F_]+|o[0-7_]+|b[01_]+)$/;
const YAML_SPECIAL_NUMBER = /^[-+]?\.(?:inf|nan)$/i;
const YAML_CONSTANT = /^(?:true|false|yes|no|on|off|null|~)$/i;

export function classifyYamlScalar(text: string): YamlScalarKind {
  const value = text.trim();
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

export function languageForPath(
  path: string | null | undefined,
): EditorLanguage | null {
  if (!path) return null;
  const lower = path.toLowerCase();
  return lower.endsWith(".yml") || lower.endsWith(".yaml") ? "yaml" : null;
}

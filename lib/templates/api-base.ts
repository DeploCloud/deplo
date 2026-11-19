const DEFAULT_TEMPLATES_API_URL = "https://templates.deplo.build";

export function templatesApiBase(): string {
  return (
    process.env.DEPLO_TEMPLATES_API_URL || DEFAULT_TEMPLATES_API_URL
  ).replace(/\/+$/, "");
}

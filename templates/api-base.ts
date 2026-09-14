// The CSP in proxy.ts must allow this same origin, or every template logo is blocked.
const DEFAULT_TEMPLATES_API_URL = "https://templates.deplo.build";

// templatesApiBase returns the base URL with any trailing slash removed.
export function templatesApiBase(): string {
  return (
    process.env.DEPLO_TEMPLATES_API_URL || DEFAULT_TEMPLATES_API_URL
  ).replace(/\/+$/, "");
}

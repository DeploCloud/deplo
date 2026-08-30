/**
 * Where the one-click template catalog lives. Shared by the catalog client and the
 * CSP in `proxy.ts`, which has to allow the same origin the cards load their logos
 * from - a default in one and not the other silently blocks every template image.
 */

/** The public catalog. Overridable so an instance can point at its own mirror. */
const DEFAULT_TEMPLATES_API_URL = "https://templates.deplo.build";

/** Base URL with any trailing slash removed, so `${base}${path}` is safe. */
export function templatesApiBase(): string {
  return (
    process.env.DEPLO_TEMPLATES_API_URL || DEFAULT_TEMPLATES_API_URL
  ).replace(/\/+$/, "");
}

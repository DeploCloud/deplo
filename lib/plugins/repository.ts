import "server-only";

/**
 * App-repository client — the read-only outbound fetch to the app catalog host
 * (`devrepo.pixelfederico.com` by default). Mirrors the shape of
 * `lib/data/updates.ts`: a static User-Agent, Next time-based revalidation, and
 * graceful degradation (a network/parse failure surfaces as a thrown Error the
 * caller can show, never a half-parsed object).
 *
 * Everything fetched is validated with zod (`./manifest`) before it leaves this
 * module: a malformed catalog/manifest is rejected rather than handed to the
 * runtime. The `image`/`env` values inside a valid manifest are treated as
 * OPAQUE — this module never evaluates them; it only validates their shape.
 */

import {
  PluginCatalogSchema,
  PluginManifestSchema,
  type PluginListing,
  type PluginManifest,
} from "./manifest";

/** The app repository base URL. Operator-overridable; trailing slash trimmed. */
const REPO_BASE = (
  process.env.DEPLO_PLUGIN_REPO_URL?.trim() || "https://devrepo.pixelfederico.com"
).replace(/\/+$/, "");

/** Cap on a repository response body so a hostile/buggy host can't OOM us. */
const MAX_BYTES = 1_000_000; // 1 MB — a catalog/manifest is a few KB.

/** How long Next caches a repository response (seconds). */
const REVALIDATE = 300;

/**
 * GET a JSON document from the repository with a hard size cap. Reads the body
 * as text first (so we can enforce `MAX_BYTES` before parsing) and returns the
 * parsed value as `unknown` for the caller's zod schema to validate. Throws a
 * descriptive Error on any HTTP, size, or parse failure.
 *
 * `fresh` bypasses the Next fetch cache (`cache: "no-store"`). The catalog
 * (browsing) tolerates the lightly-cached path; the MANIFEST must be fresh at
 * install time, because a stale manifest would run the WRONG image — exactly
 * the failure where Deplo kept pulling a previous `image` ref after it changed
 * upstream. Correctness at install beats shaving a fetch.
 */
async function fetchJson(path: string, fresh = false): Promise<unknown> {
  const url = `${REPO_BASE}${path.startsWith("/") ? path : `/${path}`}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "deplo-control-plane",
      },
      ...(fresh ? { cache: "no-store" as const } : { next: { revalidate: REVALIDATE } }),
    });
  } catch (e) {
    throw new Error(
      `App repository unreachable: ${e instanceof Error ? e.message : "fetch failed"}`,
    );
  }
  if (!res.ok) {
    throw new Error(`App repository returned ${res.status} for ${path}`);
  }
  const len = Number(res.headers.get("content-length") ?? "0");
  if (len > MAX_BYTES) {
    throw new Error(`App repository response too large (${len} bytes)`);
  }
  const text = await res.text();
  if (text.length > MAX_BYTES) {
    throw new Error(`App repository response too large (${text.length} bytes)`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`App repository returned invalid JSON for ${path}`);
  }
}

/**
 * Fetch + validate the catalog (`catalog.json`) — the list of installable apps.
 * Throws if the document is unreachable or fails schema validation.
 */
export async function fetchCatalog(): Promise<PluginListing[]> {
  const raw = await fetchJson("/catalog.json");
  const parsed = PluginCatalogSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`App catalog failed validation: ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * Fetch + validate one app's manifest, addressed by its catalog listing's
 * `manifestUrl` (a repository-relative path). Throws on unreachable / invalid.
 */
export async function fetchManifest(listing: PluginListing): Promise<PluginManifest> {
  // Fresh, uncached: this manifest decides which image Deplo actually runs, so a
  // stale copy would install the wrong container.
  const raw = await fetchJson(listing.manifestUrl, true);
  const parsed = PluginManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Manifest for "${listing.id}" failed validation: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/** The configured repository base URL — exposed for diagnostics/UI. */
export function pluginRepoBase(): string {
  return REPO_BASE;
}

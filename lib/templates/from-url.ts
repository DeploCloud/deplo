import "server-only";

import { isValidLogoValue, MAX_LOGO_BYTES } from "../apps/logo-shared";
import {
  assertComposeWithinLimits,
  loadComposeDoc,
  MAX_COMPOSE_BYTES,
  servicesOf,
} from "../deploy/compose-lint/document";
import { readBytesCapped } from "../http/body-cap";
import { assertSafeOutboundUrl } from "../outbound-url";

// https://deplo.build/docs/guides/deploy/deploy-button
const MAX_TOML_BYTES = 64 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 10_000;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

export interface ComposeFromUrl {
  compose: string;
  config: string;
  logo: string | null;
  name: string;
  origin: string;
}

export function rawComposeUrl(input: string): string {
  const url = new URL(input);
  const blob = /^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/.exec(url.pathname);
  if (url.hostname === "github.com" && blob)
    return `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}`;
  url.pathname = url.pathname.replace("/-/blob/", "/-/raw/");
  return url.toString();
}

// Assumes a one-segment ref (main, v1.2.0, a commit), which is what a pinned link carries.
export function composeOrigin(input: string): { label: string; name: string } {
  const url = new URL(rawComposeUrl(input));
  const parts = url.pathname.split("/").filter(Boolean);
  const github = url.hostname === "raw.githubusercontent.com";
  const dash = parts.indexOf("-");
  const [repo, file] = github
    ? [parts.slice(0, 2), parts.slice(3)]
    : dash > 0
      ? [parts.slice(0, dash), parts.slice(dash + 3)]
      : [parts.slice(0, -1), parts.slice(-1)];
  const host = github ? "github.com" : url.hostname;
  // The catalogue layout is <template>/default/: that variant folder says nothing about the app.
  const folder =
    file
      .slice(0, -1)
      .filter((part) => part !== "default")
      .at(-1) ?? repo.at(-1);
  return { label: [host, ...repo].join("/"), name: folder ?? host };
}

function sentence(what: string): string {
  return what[0].toUpperCase() + what.slice(1);
}

// null = nothing at that address (404/410); every other failure throws a readable message.
async function fetchFile(
  url: string,
  max: number,
  what: string,
  signal: AbortSignal,
): Promise<Buffer | null> {
  let target = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertSafeOutboundUrl(target, "The compose URL");
    const host = new URL(target).host;
    const failed = () =>
      new Error(
        signal.aborted
          ? `${host} took too long to answer.`
          : `Deplo couldn't reach ${host}.`,
      );
    let res: Response;
    try {
      res = await fetch(target, {
        signal,
        cache: "no-store",
        redirect: "manual",
      });
    } catch {
      throw failed();
    }
    const to =
      res.status >= 300 && res.status < 400 && res.headers.get("location");
    if (to || !res.ok) await res.body?.cancel().catch(() => {});
    if (to) {
      target = new URL(to, target).toString();
      continue;
    }
    if (res.status === 404 || res.status === 410) return null;
    if (!res.ok) throw new Error(`${host} answered ${res.status} for ${what}.`);
    const bytes = await readBytesCapped(res, max).catch(() => {
      throw failed();
    });
    if (!bytes)
      throw new Error(
        `${sentence(what)} is too large (${Math.round(max / 1024)} KiB max).`,
      );
    return bytes;
  }
  throw new Error(`${sentence(what)} redirects too many times.`);
}

async function siblingLogo(
  base: string,
  signal: AbortSignal,
): Promise<string | null> {
  const kinds = [
    ["logo.png", "image/png", (b: Buffer) => b.subarray(0, 4).equals(PNG)],
    ["logo.svg", "image/svg+xml", (b: Buffer) => /<svg[\s>]/.test(String(b))],
  ] as const;
  for (const [file, type, looksRight] of kinds) {
    const bytes = await fetchFile(
      new URL(file, base).toString(),
      MAX_LOGO_BYTES,
      "the logo",
      signal,
    ).catch(() => null);
    if (!bytes?.length || !looksRight(bytes)) continue;
    const uri = `data:${type};base64,${bytes.toString("base64")}`;
    if (isValidLogoValue(uri)) return uri;
  }
  return null;
}

export async function loadComposeFromUrl(
  input: string,
): Promise<({ ok: true } & ComposeFromUrl) | { ok: false; error: string }> {
  let url: string;
  try {
    url = rawComposeUrl(input);
  } catch {
    return { ok: false, error: "The compose URL must be a valid URL." };
  }
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    const [composeBytes, configBytes, logo] = await Promise.all([
      fetchFile(url, MAX_COMPOSE_BYTES, "the compose file", signal),
      fetchFile(
        new URL("template.toml", url).toString(),
        MAX_TOML_BYTES,
        "template.toml",
        signal,
      ),
      siblingLogo(url, signal),
    ]);
    if (!composeBytes)
      throw new Error(`${new URL(url).host} has no file at this address.`);
    const compose = composeBytes.toString("utf8");
    assertComposeWithinLimits(compose);
    const services = servicesOf(compose);
    if (!services)
      throw new Error("This file isn't a Compose file: it has no services.");
    const built = Object.entries(services).find(
      ([, s]) => s && typeof s === "object" && "build" in s && !("image" in s),
    );
    if (built)
      throw new Error(
        `The "${built[0]}" service builds from source, which needs the repository. Deploy the repository from Git instead.`,
      );
    const named = loadComposeDoc<{ name?: unknown }>(compose)?.name;
    const origin = composeOrigin(url);
    return {
      ok: true,
      compose,
      config: configBytes?.toString("utf8") ?? "",
      logo,
      name: typeof named === "string" && named.trim() ? named : origin.name,
      origin: origin.label,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

import { parseImageRef } from "../registry/image-ref";
export interface Purl {
  type: string;
  namespace: string;
  name: string;
  version: string;
  qualifiers: Record<string, string>;
}

export interface OsvQuery {
  ecosystem: string;
  name: string;
  version: string;
}

export interface Distro {
  id: string;
  version: string;
}

const LANGUAGE: Record<string, string> = {
  npm: "npm",
  pypi: "PyPI",
  gem: "RubyGems",
  cargo: "crates.io",
  golang: "Go",
  maven: "Maven",
  composer: "Packagist",
  nuget: "NuGet",
  hex: "Hex",
  pub: "Pub",
};

// Kernel sources ship headers into images but never run there: matching them is pure noise.
const KERNEL_SOURCES = new Set([
  "linux",
  "linux-headers",
  "linux-lts",
  "linux-signed-amd64",
  "linux-signed-arm64",
]);

export function parsePurl(purl: string): Purl | null {
  if (!purl.startsWith("pkg:")) return null;
  let rest = purl.slice(4).split("#")[0];
  const qualifiers: Record<string, string> = {};
  const q = rest.indexOf("?");
  if (q !== -1) {
    for (const kv of rest.slice(q + 1).split("&")) {
      const [k, v = ""] = kv.split("=");
      if (k) qualifiers[k] = decodeURIComponent(v);
    }
    rest = rest.slice(0, q);
  }
  let version = "";
  const at = rest.lastIndexOf("@");
  if (at > rest.lastIndexOf("/")) {
    version = decodeURIComponent(rest.slice(at + 1));
    rest = rest.slice(0, at);
  }
  const parts = rest.split("/").map(decodeURIComponent);
  if (parts.length < 2 || !parts[0] || !parts[parts.length - 1]) return null;
  return {
    type: parts[0].toLowerCase(),
    namespace: parts.slice(1, -1).join("/"),
    name: parts[parts.length - 1],
    version,
    qualifiers,
  };
}

// A vendor's own Go binary often carries no version; the image's tag is that version (grafana/grafana:8.3.0).
export function versionFromImageTag(purl: string, imageRef: string): string {
  const p = parsePurl(purl);
  if (!p || p.version || p.type !== "golang") return purl;
  const ref = parseImageRef(imageRef);
  const tag = ref?.tag.match(/^v?(\d+\.\d+(?:\.\d+)?)$/)?.[1];
  const repo = ref?.repository.replace(/^library\//, "");
  if (!tag || !repo || !`${p.namespace}/${p.name}`.endsWith(`/${repo}`))
    return purl;
  const cut = purl.search(/[?#]/);
  const end = cut === -1 ? purl.length : cut;
  return `${purl.slice(0, end)}@v${tag}${purl.slice(end)}`;
}

export function isDistroEcosystem(ecosystem: string): boolean {
  return /^(Debian|Ubuntu|Alpine|Wolfi|Chainguard)(:|$)/.test(ecosystem);
}

// The OSV query that matches one package of an image, or null when OSV has no ecosystem for it.
export function osvQueryFor(purl: string, distro: Distro): OsvQuery | null {
  const p = parsePurl(purl);
  if (!p || !p.version) return null;
  if (p.type === "deb" || p.type === "apk") return distroQuery(p, distro);
  const ecosystem = LANGUAGE[p.type];
  if (!ecosystem) return null;
  const scoped = p.namespace ? `${p.namespace}/${p.name}` : p.name;
  switch (p.type) {
    case "maven":
      return p.namespace
        ? { ecosystem, name: `${p.namespace}:${p.name}`, version: p.version }
        : null;
    case "pypi":
      return {
        ecosystem,
        name: p.name.toLowerCase().replace(/[-_.]+/g, "-"),
        version: p.version,
      };
    case "golang":
      return {
        ecosystem,
        name: scoped,
        version: p.name === "stdlib" ? p.version.replace(/^go/, "") : p.version,
      };
    default:
      return { ecosystem, name: scoped, version: p.version };
  }
}

function distroQuery(p: Purl, distro: Distro): OsvQuery | null {
  const [srcName, srcVersion] = (p.qualifiers.upstream ?? "").split("@");
  const name = srcName || p.name;
  const version = srcVersion || p.version;
  if (KERNEL_SOURCES.has(name)) return null;
  const ver =
    distro.version || (p.qualifiers.distro ?? "").replace(/^[a-z]+-/, "");
  const ecosystem = distroEcosystem(p.type, p.namespace, ver);
  return ecosystem ? { ecosystem, name, version } : null;
}

function distroEcosystem(
  type: string,
  vendor: string,
  version: string,
): string | null {
  if (type === "deb" && vendor === "debian") {
    const major = version.split(".")[0];
    return /^\d+$/.test(major) ? `Debian:${major}` : null;
  }
  if (type === "deb" && vendor === "ubuntu")
    return /^\d+\.\d+$/.test(version) ? `Ubuntu:${version}` : null;
  if (type === "apk" && vendor === "alpine") {
    const m = /^(\d+\.\d+)/.exec(version);
    return m ? `Alpine:v${m[1]}` : null;
  }
  if (type === "apk" && vendor === "wolfi") return "Wolfi";
  if (type === "apk" && vendor === "chainguard") return "Chainguard";
  return null;
}

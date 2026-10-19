import { interpolates, servicesOf } from "./compose-lint/document";
import { labelEntries } from "./compose-lint/traefik-labels";

export type TraefikLabel = { key: string; value: string };

export function validateTraefikLabels(labels: TraefikLabel[]): TraefikLabel[] {
  if (labels.length > 256)
    throw new Error("Use at most 256 Traefik labels per service");
  const seen = new Set<string>();
  let bytes = 0;
  return labels.map(({ key, value }) => {
    key = key.trim();
    if (
      !/^traefik\.(?:enable|(?:http|tcp|udp|docker|swarm)\.[^\s=$\u0000-\u001f]+)$/i.test(
        key,
      )
    )
      throw new Error(
        `Invalid Traefik label: ${key}. Use traefik.http, traefik.tcp or traefik.udp for routing.`,
      );
    if (seen.has(key.toLowerCase()))
      throw new Error(`Duplicate Traefik label: ${key}`);
    seen.add(key.toLowerCase());
    bytes += new TextEncoder().encode(key + value).length;
    if (bytes > 65_536 || /[\u0000\r\n]/.test(value))
      throw new Error(
        "Traefik labels must fit in 64 KiB and contain no line breaks or null bytes",
      );
    if (interpolates(value))
      throw new Error(
        "Write Traefik label values directly; use $$ for a literal dollar sign. Environment variables cannot change proxy permissions.",
      );
    return { key, value };
  });
}

export function traefikLabelsFrom(labels: unknown): TraefikLabel[] {
  return labelEntries(labels)
    .filter(([key]) => key.trim().toLowerCase().startsWith("traefik."))
    .map(([key, value]) => {
      if (value === undefined)
        throw new Error(`Write a value for Traefik label ${key}`);
      return { key, value };
    });
}

export function composeTraefikLabels(
  compose: string | null | undefined,
): Map<string, TraefikLabel[]> {
  const result = new Map<string, TraefikLabel[]>();
  for (const [name, service] of Object.entries(
    servicesOf(compose ?? null) ?? {},
  )) {
    if (!service || typeof service !== "object") continue;
    const labels = traefikLabelsFrom((service as { labels?: unknown }).labels);
    if (labels.length) result.set(name, labels);
  }
  return result;
}

function hasCompleteCustomRouting(
  labels: TraefikLabel[],
  generatedKeys: Set<string>,
): boolean {
  const values = new Map(
    labels.map(({ key, value }) => [key.toLowerCase(), value]),
  );
  const routers = [...values.keys()].filter(
    (key) =>
      !generatedKeys.has(key) &&
      /^traefik\.(?:(http|tcp)\.routers\.[^.]+\.rule|udp\.routers\.[^.]+\.service)$/.test(
        key,
      ),
  );
  return (
    routers.length > 0 &&
    routers.every((key) => {
      const protocol = key.split(".")[1];
      const reference = values.get(
        key.replace(/\.(rule|service)$/, ".service"),
      );
      if (reference?.includes("@") && !reference.endsWith("@docker"))
        return true;
      const ports = [...values.keys()].filter(
        (entry) =>
          entry.startsWith(`traefik.${protocol}.services.`) &&
          entry.endsWith(".loadbalancer.server.port"),
      );
      if (!reference) return ports.length === 1;
      return ports.includes(
        `traefik.${protocol}.services.${reference.replace(/@docker$/, "").toLowerCase()}.loadbalancer.server.port`,
      );
    })
  );
}

export function overlayTraefikLabels(
  generated: string[],
  labels: TraefikLabel[],
): string[] {
  if (!labels.length) return generated;
  const overrides = validateTraefikLabels(labels);
  const generatedKeys = new Set(
    generated.map((entry) => entry.slice(0, entry.indexOf("=")).toLowerCase()),
  );
  const manual = hasCompleteCustomRouting(overrides, generatedKeys);
  const result = new Map<string, string>();
  for (const entry of generated) {
    const split = entry.indexOf("=");
    const key = entry.slice(0, split).toLowerCase();
    if (manual && /^traefik\.(http|tcp|udp)\.(routers|services)\./.test(key))
      continue;
    result.set(key, entry);
  }
  if (manual) result.set("traefik.enable", "traefik.enable=true");
  if (!manual) {
    const middlewares = [
      ...new Set(
        overrides.flatMap(({ key }) => {
          const match = /^traefik\.http\.middlewares\.([^.]+)\./i.exec(key);
          return match ? [match[1]] : [];
        }),
      ),
    ];
    for (const key of generatedKeys) {
      if (
        !/^traefik\.http\.routers\.[^.]+\.rule$/.test(key) ||
        !middlewares.length
      )
        continue;
      const target = key.replace(/\.rule$/, ".middlewares");
      const current =
        result.get(target)?.split("=").slice(1).join("=").split(",") ?? [];
      result.set(
        target,
        `${target}=${[...new Set([...current, ...middlewares])].join(",")}`,
      );
    }
  }
  for (const { key, value } of overrides)
    result.set(key.toLowerCase(), `${key}=${value}`);
  return [...result.values()];
}

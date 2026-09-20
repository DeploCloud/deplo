import yaml from "../../yaml";

import { buildComposeStack } from "./render";
import type { ComposeStackInput, ComposeDomainRoute } from "./types";
import type { VolumeMount } from "../../types/container";

export type Svc = {
  ports?: unknown[];
  networks?: unknown;
  labels?: unknown;
  environment?: unknown;
};
export type Doc = { services: Record<string, Svc> };

export type BuildSvc = Svc & {
  build?: { context?: string; labels?: unknown } | string;
};

export const WEB_API_COMPOSE = `
services:
  web:
    image: nginx
    ports:
      - "80:80"
  api:
    image: api
    ports:
      - "8080:8080"
`;

export function route(
  name: string,
  service: string,
  port: number | null = null,
): ComposeDomainRoute {
  return { name, service, port, pathPrefix: "", stripPrefix: false };
}

export function buildDoc(
  compose: string,
  extra: Partial<ComposeStackInput> = {},
): Doc {
  const out = buildComposeStack({
    network: "deplo-team-team_test",
    compose,
    name: "deplo-demo",
    deployKey: "demo",
    appId: "p1",
    domainRoutes: [route("demo.1.2.3.4.deplo.site", "web", 80)],
    ...extra,
  });
  return yaml.load(out) as Doc;
}

export function labelsOf(svc: Svc): string[] {
  return Array.isArray(svc.labels) ? (svc.labels as string[]) : [];
}

export function volsOf(svc: Svc & { volumes?: unknown }): string[] {
  return Array.isArray(svc.volumes) ? (svc.volumes as string[]) : [];
}

export function vol(
  v: Partial<VolumeMount> & { mountPath: string },
): VolumeMount {
  return { id: "vol_1", name: "data", readOnly: false, ...v };
}

export function topVolumes(doc: Doc): Record<string, { name?: string }> {
  return ((doc as unknown as { volumes?: unknown }).volumes ?? {}) as Record<
    string,
    { name?: string }
  >;
}

export function envOf(svc: Svc): string[] {
  const e = svc.environment;
  if (Array.isArray(e)) return e.map(String);
  if (e && typeof e === "object") {
    return Object.entries(e as Record<string, unknown>).map(([k, v]) =>
      v === null || v === undefined ? k : `${k}=${String(v)}`,
    );
  }
  return [];
}

export function networksOf(
  compose: string,
  extra: Partial<ComposeStackInput> = {},
) {
  const out = buildComposeStack({
    network: "deplo-env-environ_mine",
    compose,
    name: "deplo-demo",
    deployKey: "demo",
    appId: "p1",
    domainRoutes: [],
    ...extra,
  });
  return yaml.load(out) as {
    networks: Record<string, { name?: string }>;
    services: Record<string, { networks?: string[] }>;
  };
}

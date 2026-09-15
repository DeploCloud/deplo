import "server-only";

import { primaryDomainRow } from "../../data/domains/primary-domain";
import {
  routableRoutes,
  defaultRoute,
  pendingPrimaryRoute,
  type RoutableDomain,
} from "../../data/domains/routes";
import type { App } from "../../types/app";
import type { DeploymentEnvironment } from "../../types/deployment";
import type { CertProvider } from "../../types/domain";
import { usesComposeStack } from "../../utils";
import { detectDefaultApp } from "../compose-stack/compose-read";

export async function previewRouteTarget(
  project: App,
  previewPort: number | null,
): Promise<{ service: string | null; port: number | null }> {
  if (!usesComposeStack(project)) return { service: null, port: previewPort };
  const primaryRow = await primaryDomainRow(project.id);
  if (primaryRow?.service) {
    return {
      service: primaryRow.service,
      port: previewPort ?? primaryRow.port ?? null,
    };
  }
  const detected = detectDefaultApp(project.compose ?? null);
  return {
    service: detected?.service ?? null,
    port: previewPort ?? detected?.port ?? null,
  };
}

export async function routableForDeploy(
  appId: string,
  environment: DeploymentEnvironment,
  primary: string,
  previewCertProvider?: CertProvider,
  previewTarget?: { service: string | null; port: number | null },
): Promise<RoutableDomain[]> {
  if (environment !== "production") {
    return [
      defaultRoute(
        primary,
        previewTarget?.service ?? null,
        previewTarget?.port ?? null,
        {
          certProvider: previewCertProvider ?? "none",
        },
      ),
    ];
  }
  const [valid, fallback] = await Promise.all([
    routableRoutes(appId),
    pendingPrimaryRoute(appId, primary),
  ]);
  return orderDeployRoutes(valid, primary, fallback);
}

export function orderDeployRoutes(
  valid: RoutableDomain[],
  primary: string,
  fallback?: RoutableDomain | null,
): RoutableDomain[] {
  const primaryFallback = () => fallback ?? defaultRoute(primary);
  if (valid.length === 0) return primary ? [primaryFallback()] : [];
  const primaryRoute =
    valid.find((d) => d.name === primary) ?? primaryFallback();
  return [primaryRoute, ...valid.filter((d) => d !== primaryRoute)];
}

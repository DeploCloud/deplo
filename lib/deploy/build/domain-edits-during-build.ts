import "server-only";

import { loadDeployment } from "../../data/app-graph-load";
import { activateAppTunnel } from "../../data/clusters/app-tunnel";
import {
  primaryDomainName,
  syncProductionUrl,
} from "../../data/domains/primary-domain";
import type { RoutableDomain } from "../../data/domains/routes";
import { routableForDeploy } from "./deploy-routes";
import { log } from "./deployment-state";
import { rerouteApp } from "./reroute";

const CONNECTOR_WAIT_MS = 30_000;

const routesKey = (routes: RoutableDomain[]) =>
  routes
    .map((r) => JSON.stringify(r))
    .sort()
    .join("\n");

// A domain edit during the build is deferred, and the stack went live with the routes read at its start.
export async function applyDomainEditsMadeDuringBuild(
  depId: string,
  appId: string,
  builtRoutes: RoutableDomain[],
): Promise<void> {
  try {
    if ((await loadDeployment(depId))?.status !== "ready") return;
    // The App is up and its connector has just started: its domains switch once Cloudflare sees it.
    if ((await activateAppTunnel(appId, CONNECTOR_WAIT_MS)) > 0)
      log(depId, "info", "Switched its Cloudflare domains to the App's tunnel");
    const current = await routableForDeploy(
      appId,
      "production",
      await primaryDomainName(appId),
    );
    if (routesKey(current) !== routesKey(builtRoutes)) {
      const result = await rerouteApp(appId);
      if (result === "deferred") return;
      if (result === "rerouted")
        log(depId, "info", "Applied the domain changes made during the build");
    }
    await syncProductionUrl(appId);
  } catch (e) {
    log(
      depId,
      "warn",
      `The domain changes made during the build could not be applied: ${
        e instanceof Error ? e.message : String(e)
      }. Deploy again to apply them.`,
    );
  }
}

import type { ReadyCheck } from "../../agent/gen/agent";
import type { RoutableDomain } from "../../data/domains/routes";
import { composeRoutePort } from "../compose-lint/routing";

// The first routed port must answer before a deploy is ready; an app with no domain only has to stay up.
export function readyCheckFor(opts: {
  routes: RoutableDomain[];
  appPort?: number | null;
  stack?: boolean;
  compose?: string | null;
}): ReadyCheck {
  const route = opts.routes.find((r) => !r.redirectTo) ?? opts.routes[0];
  if (opts.stack) {
    const service = route?.service ?? "";
    const port =
      route?.port ??
      (service ? composeRoutePort(opts.compose ?? null, service) : null) ??
      0;
    return { port, portRequired: Boolean(service) && port > 0, service };
  }
  const port = route?.port ?? opts.appPort ?? 0;
  return { port, portRequired: Boolean(route) && port > 0, service: "" };
}

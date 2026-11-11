import { withTunnelConnector } from "./panel-tunnel-stack";

// `_` never appears in an app's slug, so no app's container can hold this name.
export function appConnectorService(slug: string): string {
  return `deplo-connector_${slug}`;
}

/** The App's rendered stack with its tunnel's connector beside it; the agent starts it once the App is ready. */
export function withAppConnector(
  stackYaml: string,
  slug: string,
  token: string,
): string {
  return withTunnelConnector(stackYaml, appConnectorService(slug), token, {
    startAfterReady: true,
  });
}

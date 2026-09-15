import { ContractVersion } from "../../agent/gen/agent";
import {
  buildChecks,
  featuresCheck,
  helloFailure,
  versionCheck,
} from "./agent-checks";
import { diskCheck } from "./capacity-checks";
import {
  READINESS_DETAILS,
  READINESS_HINTS,
  READINESS_MESSAGES,
} from "./messages";
import {
  HTTPS_PORT,
  HTTP_PORT,
  portCheck,
  traefikCheck,
} from "./routing-checks";
import type { ReadinessCheck, ReadinessProbe, ReadinessReport } from "./types";
import { report } from "./verdict";

export function classifyServerReadiness(
  probe: ReadinessProbe,
): ReadinessReport {
  const { server } = probe;
  const checks: ReadinessCheck[] = [];

  const provisioning = !server.agent?.certFingerprint;

  if (provisioning) {
    checks.push({
      id: "agent.bootstrap",
      group: "agent",
      label: "Agent installed",
      severity: "warn",
      detail: READINESS_MESSAGES.notProvisioned,
      hint: READINESS_HINTS.installAgent,
    });
    checks.push(...configChecks(probe));
    return report(probe, checks, { provisioning: true });
  }

  if (probe.helloError || !probe.hello) {
    checks.push(helloFailure(probe.helloError));
    checks.push(...configChecks(probe));
    return report(probe, checks, { provisioning: false });
  }

  const hello = probe.hello;

  checks.push({
    id: "agent.hello",
    group: "agent",
    label: "Agent handshake",
    severity: "pass",
    detail: READINESS_DETAILS.helloOk,
  });

  if (hello.contractVersion !== ContractVersion.CONTRACT_VERSION_V1) {
    checks.push({
      id: "agent.contract",
      group: "agent",
      label: "Agent protocol",
      severity: "fail",
      detail: READINESS_MESSAGES.contract,
      hint: READINESS_HINTS.updateAgent,
    });
    checks.push(...configChecks(probe));
    return report(probe, checks, { provisioning: false });
  }

  checks.push({
    id: "agent.contract",
    group: "agent",
    label: "Agent protocol",
    severity: "pass",
    detail: READINESS_DETAILS.contractOk,
  });
  checks.push(versionCheck(hello.agentVersion));
  checks.push(featuresCheck(hello.capabilities ?? []));

  checks.push(
    hello.dockerAvailable
      ? {
          id: "docker.available",
          group: "docker",
          label: "Docker engine",
          severity: "pass",
          detail: READINESS_DETAILS.dockerOk(hello.dockerVersion),
        }
      : probe.server.storageOnly
        ? {
            id: "docker.available",
            group: "docker",
            label: "Docker engine",
            severity: "skip",
            detail: READINESS_DETAILS.dockerSkippedStorageOnly,
          }
        : {
            id: "docker.available",
            group: "docker",
            label: "Docker engine",
            severity: "fail",
            detail: READINESS_MESSAGES.dockerDown,
            hint: READINESS_HINTS.startDocker,
          },
  );

  const traefik: boolean | null = hello.dockerAvailable
    ? hello.traefikRunning
    : null;
  checks.push(traefikCheck(traefik, probe.server.buildOnly));
  checks.push(
    portCheck(
      "routing.port80",
      "Port 80 (HTTP)",
      HTTP_PORT,
      probe.port80,
      traefik,
    ),
  );
  checks.push(
    portCheck(
      "routing.port443",
      "Port 443 (HTTPS)",
      HTTPS_PORT,
      probe.port443,
      traefik,
    ),
  );

  checks.push(diskCheck(probe.metrics));

  checks.push(...buildChecks(hello.capabilities ?? []));

  checks.push(...configChecks(probe));

  return report(probe, checks, { provisioning: false });
}

function configChecks(probe: ReadinessProbe): ReadinessCheck[] {
  const { server, grantedTeamCount } = probe;
  const access: ReadinessCheck = server.allTeams
    ? {
        id: "config.teamAccess",
        group: "config",
        label: "Team access",
        severity: "info",
        detail: READINESS_DETAILS.teamsAll,
      }
    : grantedTeamCount > 0
      ? {
          id: "config.teamAccess",
          group: "config",
          label: "Team access",
          severity: "info",
          detail: READINESS_DETAILS.teamsSome(grantedTeamCount),
        }
      : {
          id: "config.teamAccess",
          group: "config",
          label: "Team access",
          severity: "fail",
          detail: READINESS_MESSAGES.noTeamAccess,
          hint: READINESS_HINTS.grantTeamAccess,
        };
  return [
    access,
    {
      id: "config.deployConcurrency",
      group: "config",
      label: "Deploy concurrency",
      severity: "info",
      detail: READINESS_DETAILS.concurrency(server.deployConcurrency),
    },
  ];
}

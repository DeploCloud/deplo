import {
  READINESS_DETAILS,
  READINESS_HINTS,
  READINESS_MESSAGES,
} from "./messages";
import type { PortProbe, ReadinessCheck } from "./types";

/** The Hello flag that gates CheckPort. Mirrors BACKUP_CAPABILITY / SELF_UPDATE_CAPABILITY. */
export const CHECKPORT_CAPABILITY = "checkport";

/** The web ports Traefik publishes. Nothing else is probed. */
export const HTTP_PORT = 80;
export const HTTPS_PORT = 443;

/**
 * Traefik being down is a WARN, never a fail - a database-only or worker host legitimately has
 * none, and a status that fires on a normal configuration is one operators learn to ignore.
 */
export function traefikCheck(
  traefik: boolean | null,
  buildOnly = false,
): ReadinessCheck {
  const base = {
    id: "routing.traefik",
    group: "routing" as const,
    label: "Traefik proxy",
  };
  // A BUILD SERVER has no proxy by design - the installer skips it.
  if (buildOnly)
    return {
      ...base,
      severity: "skip",
      detail: READINESS_DETAILS.traefikSkippedBuildOnly,
    };
  if (traefik === null)
    return {
      ...base,
      severity: "skip",
      detail: READINESS_MESSAGES.traefikUnknown,
      hint: READINESS_HINTS.startDocker,
    };
  return traefik
    ? { ...base, severity: "pass", detail: READINESS_DETAILS.traefikOk }
    : {
        ...base,
        severity: "warn",
        detail: READINESS_MESSAGES.traefikDown,
        hint: READINESS_HINTS.installTraefik,
      };
}

// portCheck - reads one CheckPort result, which binds 0.0.0.0:<port> and releases it.
export function portCheck(
  id: string,
  label: string,
  port: number,
  probe: PortProbe,
  traefik: boolean | null,
): ReadinessCheck {
  const base = { id, group: "routing" as const, label };
  switch (probe.kind) {
    case "unsupported":
      return {
        ...base,
        severity: "skip",
        detail: READINESS_DETAILS.portUnsupported(port),
        hint: READINESS_HINTS.updateAgent,
      };
    case "failed":
      return {
        ...base,
        severity: "skip",
        detail: READINESS_DETAILS.portFailed(port),
        hint: READINESS_HINTS.retry,
      };
    case "skipped":
      return {
        ...base,
        severity: "skip",
        detail: READINESS_DETAILS.portSkipped(port),
        hint: READINESS_HINTS.retry,
      };
    case "held":
      if (traefik === null)
        return {
          ...base,
          severity: "info",
          detail: READINESS_DETAILS.portHeldTraefikUnknown(port),
        };
      return traefik
        ? {
            ...base,
            severity: "pass",
            detail: READINESS_DETAILS.portHeldWithTraefik(port),
          }
        : {
            ...base,
            severity: "warn",
            detail: READINESS_DETAILS.portHeldNoTraefik(port),
            hint: READINESS_HINTS.freeWebPort,
          };
    case "free":
      if (traefik === null)
        return {
          ...base,
          severity: "info",
          detail: READINESS_DETAILS.portFreeTraefikUnknown(port),
        };
      return traefik
        ? {
            ...base,
            severity: "warn",
            detail: READINESS_DETAILS.portFreeWithTraefik(port),
            hint: READINESS_HINTS.publishWebPorts,
          }
        : // Restating what routing.traefik already warned about - `info`, not a second warn.
          {
            ...base,
            severity: "info",
            detail: READINESS_DETAILS.portFreeNoTraefik(port),
          };
  }
}

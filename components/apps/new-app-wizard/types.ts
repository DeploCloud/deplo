import type { LogoAccent } from "@/lib/templates/logo-color";

export interface WizardServer {
  id: string;
  name: string;
  type: "localhost" | "remote";
  isDeploHost: boolean;
}

/** A host that can compile for another machine (Settings → Servers marks one). */
export interface WizardBuildServer {
  id: string;
  name: string;
  hostArch: string;
  buildOnly: boolean;
  isDeploHost: boolean;
}

/** The `createApp` input the wizard sends, held when a clash dialog interrupts it. */
export type CreateAppVariables = Record<string, unknown> & {
  folderId: string | null;
  projectId: string | null;
  environmentId: string | null;
  renameClashes?: boolean;
};

export interface WizardTemplate {
  id: string;
  name: string;
  variantName?: string;
  description: string;
  alerts: {
    type: "info" | "warning" | "destructive";
    message: string;
    link?: string;
  }[];
  logo: string | null;
  /** What the logo's pixels said: the hue to wash its tile in, the plate it needs. */
  veil?: LogoAccent;
  compose: string;
  env: { key: string; value: string }[];
  /** Which compose service + port Traefik exposes for this template (first). */
  expose: { service: string; port: number; path?: string } | null;
  /** Every publicly-routed service (multi-domain templates expose 2+). */
  exposes: { service: string; port: number; host?: string; path?: string }[];
  /** Pre-generated nip.io domain baked into the template's env. */
  autoDomain: string | null;
  /** Template config files to materialise at deploy time. */
  mounts: { filePath: string; content: string }[];
}

/** Where the new app lands (ADR-0009 - one home only): the folder or project environment open on the Overview. */
export interface WizardPlacement {
  label: string;
  folderId?: string | null;
  projectId?: string | null;
  environmentId?: string | null;
}

export type Step = "source" | "details" | "configure";

import type { LogoAccent } from "@/lib/templates/logo-color";

export interface WizardServer {
  id: string;
  name: string;
  type: "localhost" | "remote";
  isDeploHost: boolean;
}

export interface WizardBuildServer {
  id: string;
  name: string;
  hostArch: string;
  buildOnly: boolean;
  isDeploHost: boolean;
}

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
  veil?: LogoAccent;
  compose: string;
  env: { key: string; value: string }[];
  expose: { service: string; port: number; path?: string } | null;
  exposes: { service: string; port: number; host?: string; path?: string }[];
  autoDomain: string | null;
  mounts: { filePath: string; content: string }[];
}

export interface WizardPlacement {
  label: string;
  folderId?: string | null;
  projectId?: string | null;
  environmentId?: string | null;
}

export type Step = "source" | "details" | "configure";

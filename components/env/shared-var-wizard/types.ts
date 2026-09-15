export interface WizardRef {
  id: string;
  name: string;
  slug: string;
}

export interface AppRef extends WizardRef {
  projectId: string | null;
  environmentId: string | null;
  logo: string | null;
  primaryDomain: string | null;
}

export interface ProjectRef extends WizardRef {
  color: string | null;
  appCount: number;
  environmentCount: number;
}

export interface TeamRef {
  id: string;
  name: string;
  avatarUrl: string | null;
}

export type StepId = "variable" | "scope" | "details" | "review";

export type ScopeId = "team" | "projects" | "apps";

export interface ProjectScope {
  mode: "all" | "some";
  envIds: string[];
}

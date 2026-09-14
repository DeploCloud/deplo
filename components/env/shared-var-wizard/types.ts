// WizardRef - an App or a Project as the wizard needs it: enough to name and identify.
export interface WizardRef {
  id: string;
  name: string;
  slug: string;
}

// AppRef - an App, plus where it lives and what it looks like.
export interface AppRef extends WizardRef {
  projectId: string | null;
  environmentId: string | null;
  logo: string | null;
  primaryDomain: string | null;
}

// ProjectRef - a Project container, with the colour + counts its Details card shows.
export interface ProjectRef extends WizardRef {
  color: string | null;
  appCount: number;
  environmentCount: number;
}

// TeamRef - a team the author may share with (they hold manage_env across all of it).
export interface TeamRef {
  id: string;
  name: string;
  avatarUrl: string | null;
}

export type StepId = "variable" | "scope" | "details" | "review";

// The three sharing scopes. Teams/projects only make the variable AVAILABLE (each app
// still opts in from its own Environment tab - ADR-0012), except a Teams scope covering
// MORE than one team, which adds it everywhere by itself (ADR-0027).
export type ScopeId = "team" | "projects" | "apps";

// ProjectScope - how one checked project shares: with all of its environments (the project
// id goes to `projectIds`) or with a hand-picked few (those env ids go to `environmentIds`
// and the project id does NOT).
export interface ProjectScope {
  mode: "all" | "some";
  envIds: string[];
}

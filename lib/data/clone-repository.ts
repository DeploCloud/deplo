import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  githubApps as githubAppsTable,
  githubInstallation as githubInstallationTable,
} from "../db/schema/control-plane/integrations";
import { getCurrentUser } from "../auth/current-user";
import {
  requireActiveTeamId,
  requireCapability,
  requireTeamWide,
} from "../membership";
import { assembleGithubApp, assembleGithubInstallation } from "./infra-rows";
import { listGitConnections, readGitCredential } from "./git-connections";
import { recordActivity } from "./activity";
import {
  cloneHostLabel,
  parseCloneSource,
  repoNameProblem,
  type CloneSource,
} from "../git/clone-source";
import {
  readSourceFiles,
  resolveSource,
  type SourceFile,
} from "../git/clone-archive";
import {
  repoCreatorFor,
  type CreatedRepo,
  type NewRepoSpec,
} from "../git/providers/create-repo";
import { providerFor } from "../git/providers/registry";
import {
  buildMetadataToken,
  GithubPermissionError,
  readAppAccess,
  scopedInstallationToken,
} from "../github/app";
import {
  addRepoToInstallation,
  createGithubRepository,
  GithubApiError,
  pushGithubFiles,
} from "../github/create-repo";
import {
  hasUserToken,
  userAuthorizeUrl,
  userToken,
} from "../github/user-token";
import { resolveManifestBaseUrl } from "../public-url";
import type {
  GitProviderId,
  GithubApp,
  GithubInstallation,
} from "../types/git";

// https://deplo.build/docs/guides/deploy/deploy-button
export interface CloneDestination {
  key: string;
  provider: "github" | GitProviderId;
  providerLabel: string;
  installationId: string | null;
  connectionId: string | null;
  ownerId: string;
  login: string;
  avatarUrl: string;
  personal: boolean;
  // What has to happen before a repository can be created here.
  needs: "github-sign-in" | "github-permissions" | null;
  settingsUrl: string | null;
}

export interface CloneDestinations {
  destinations: CloneDestination[];
  unreachable: string[];
}

async function teamInstallations(
  teamId: string,
): Promise<{ app: GithubApp; install: GithubInstallation }[]> {
  const rows = await getDb()
    .select({ app: githubAppsTable, install: githubInstallationTable })
    .from(githubInstallationTable)
    .innerJoin(
      githubAppsTable,
      eq(githubAppsTable.id, githubInstallationTable.appId),
    )
    .where(eq(githubAppsTable.teamId, teamId));
  return rows.map((r) => ({
    app: assembleGithubApp(r.app),
    install: assembleGithubInstallation(r.install),
  }));
}

export function installationSettingsUrl(
  install: Pick<
    GithubInstallation,
    "accountType" | "accountLogin" | "installationId"
  >,
): string {
  return install.accountType === "Organization"
    ? `https://github.com/organizations/${install.accountLogin}/settings/installations/${install.installationId}`
    : `https://github.com/settings/installations/${install.installationId}`;
}

export async function listCloneDestinations(): Promise<CloneDestinations> {
  const teamId = await requireActiveTeamId();
  await requireTeamWide("the team's git accounts");
  const user = await getCurrentUser();
  const destinations: CloneDestination[] = [];
  const unreachable: string[] = [];

  for (const { app, install } of await teamInstallations(teamId)) {
    const personal = install.accountType === "User";
    const access = await readAppAccess(app.id);
    const signedIn =
      personal && user ? await hasUserToken(app.id, user.id) : null;
    const missing = Boolean(access?.missingClone.length);
    destinations.push({
      key: `github:${install.id}`,
      provider: "github",
      providerLabel: "GitHub",
      installationId: install.id,
      connectionId: null,
      ownerId: install.accountLogin,
      login: install.accountLogin,
      avatarUrl: install.avatarUrl,
      personal,
      needs: missing
        ? "github-permissions"
        : personal && !signedIn
          ? "github-sign-in"
          : null,
      settingsUrl: missing ? (access?.settingsUrl ?? null) : null,
    });
  }

  const connections = (await listGitConnections()).filter(
    (c) => repoCreatorFor(c.provider) != null,
  );
  const owners = await Promise.all(
    connections.map(async (c) => {
      const cred = await readGitCredential(c.id).catch(() => null);
      const creator = repoCreatorFor(c.provider);
      if (!cred || !creator) return null;
      return creator.listOwners(cred).catch(() => null);
    }),
  );
  connections.forEach((c, i) => {
    const list = owners[i];
    if (!list) {
      unreachable.push(c.label);
      return;
    }
    for (const o of list)
      destinations.push({
        key: `git:${c.id}:${o.id}`,
        provider: c.provider,
        providerLabel: providerFor(c.provider).label,
        installationId: null,
        connectionId: c.id,
        ownerId: o.id,
        login: o.login,
        avatarUrl: o.avatarUrl,
        personal: o.personal,
        needs: null,
        settingsUrl: null,
      });
  });
  return { destinations, unreachable };
}

async function installationInTeam(installationId: string, teamId: string) {
  const found = (await teamInstallations(teamId)).find(
    (r) => r.install.id === installationId,
  );
  if (!found) throw new Error("GitHub account not found");
  return found;
}

export async function githubSignInUrl(
  installationId: string,
  returnTo: string | null,
): Promise<string> {
  const { teamId, userId } = await requireCapability("create_apps");
  const { app } = await installationInTeam(installationId, teamId);
  return userAuthorizeUrl({
    app,
    userId,
    returnTo,
    publicBase: resolveManifestBaseUrl(),
  });
}

export interface CloneRepositoryInput {
  repo?: string | null;
  compose?: string | null;
  installationId?: string | null;
  connectionId?: string | null;
  owner: string;
  name: string;
  private: boolean;
}

export interface ClonedRepository {
  provider: "github" | GitProviderId;
  fullName: string;
  url: string;
  branch: string;
  installationId: string | null;
  connectionId: string | null;
  composeFile: string | null;
}

async function readSource(source: CloneSource, teamId: string) {
  const githubToken =
    source.host === "github" ? await buildMetadataToken(teamId) : null;
  const info = await resolveSource(source, { githubToken });
  const files = await readSourceFiles(source, info.ref);
  if (source.composeFile && !files.some((f) => f.path === source.composeFile))
    throw new Error(
      `${source.fullName} has no ${source.composeFile} on ${info.ref}.`,
    );
  return { info, files };
}

function permissionsMessage(install: GithubInstallation): string {
  return `Deplo's GitHub App can't create repositories on ${install.accountLogin} yet. Give it "Administration" and "Contents" read and write access, then accept the new permissions: ${installationSettingsUrl(install)}`;
}

async function cloneToGithub(
  installationId: string,
  teamId: string,
  userId: string,
  spec: NewRepoSpec,
  files: SourceFile[],
): Promise<CreatedRepo> {
  const { app, install } = await installationInTeam(installationId, teamId);
  const personal = install.accountType === "User";
  let signedIn: Awaited<ReturnType<typeof userToken>> = null;
  let createToken: string;
  if (personal) {
    signedIn = await userToken(app, userId);
    if (!signedIn)
      throw new Error(
        `Sign in to GitHub as ${install.accountLogin} to create a repository there.`,
      );
    if (signedIn.login.toLowerCase() !== install.accountLogin.toLowerCase())
      throw new Error(
        `You're signed in to GitHub as ${signedIn.login}, not ${install.accountLogin}. Sign in as ${install.accountLogin} to create a repository there.`,
      );
    createToken = signedIn.token;
  } else {
    createToken = await scopedInstallationToken(installationId, {
      administration: "write",
    }).catch((e) => {
      throw e instanceof GithubPermissionError
        ? new Error(permissionsMessage(install))
        : e;
    });
  }

  const repo = await createGithubRepository({
    token: createToken,
    owner: install.accountLogin,
    personal,
    spec,
  }).catch((e) => {
    if (e instanceof GithubApiError && e.status === 403)
      throw new Error(permissionsMessage(install));
    throw e;
  });

  try {
    let pushToken: string;
    if (signedIn) {
      await addRepoToInstallation(
        signedIn.token,
        install.installationId,
        repo.id,
      );
      pushToken = signedIn.token;
    } else {
      pushToken = await scopedInstallationToken(
        installationId,
        { contents: "write" },
        [spec.name],
      );
    }
    return await pushGithubFiles({
      token: pushToken,
      fullName: repo.fullName,
      branch: repo.branch,
      message: spec.message,
      files,
    });
  } catch (e) {
    throw new Error(
      `Deplo created ${repo.url} but couldn't copy the code into it (${e instanceof Error ? e.message : String(e)}). Delete that repository on GitHub, then try again.`,
    );
  }
}

async function cloneToConnection(
  connectionId: string,
  ownerId: string,
  teamId: string,
  spec: NewRepoSpec,
  files: SourceFile[],
): Promise<{ created: CreatedRepo; provider: GitProviderId }> {
  const cred = await readGitCredential(connectionId);
  if (!cred || cred.teamId !== teamId) throw new Error("Git account not found");
  const creator = repoCreatorFor(cred.provider);
  if (!creator)
    throw new Error(
      `Deplo can't create repositories on a plain ${providerFor(cred.provider).label} server.`,
    );
  const owner = (await creator.listOwners(cred)).find((o) => o.id === ownerId);
  if (!owner)
    throw new Error("That account or group isn't available any more.");
  return {
    created: await creator.create(cred, owner, spec, files),
    provider: cred.provider,
  };
}

export async function cloneRepository(
  input: CloneRepositoryInput,
): Promise<ClonedRepository> {
  const { teamId, userId } = await requireCapability("create_apps");
  await requireTeamWide("the team's git accounts");
  const user = await getCurrentUser();

  const source = parseCloneSource({ repo: input.repo, compose: input.compose });
  if (!source)
    throw new Error(
      "This link doesn't point at a public GitHub or GitLab repository.",
    );
  const name = input.name.trim();
  const problem = repoNameProblem(name);
  if (problem) throw new Error(problem);
  if (!input.installationId === !input.connectionId)
    throw new Error("Pick where to create the repository.");

  // Read the code before creating anything, so a bad link never leaves an empty repository behind.
  const { info, files } = await readSource(source, teamId);
  const spec: NewRepoSpec = {
    name,
    private: input.private,
    description: info.description,
    message: `Initial commit from ${source.url} (${info.ref})`,
  };
  const { created, provider } = input.installationId
    ? {
        created: await cloneToGithub(
          input.installationId,
          teamId,
          userId,
          spec,
          files,
        ),
        provider: "github" as const,
      }
    : await cloneToConnection(
        input.connectionId!,
        input.owner,
        teamId,
        spec,
        files,
      );

  await recordActivity(
    "integration",
    `Copied ${source.fullName} from ${cloneHostLabel(source.host)} into ${created.fullName}`,
    user?.name ?? "Someone",
    null,
    teamId,
  );
  return {
    provider,
    fullName: created.fullName,
    url: created.url,
    branch: created.branch,
    installationId: input.installationId ?? null,
    connectionId: input.connectionId ?? null,
    composeFile: source.composeFile,
  };
}

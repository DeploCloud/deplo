import "server-only";

import { sourceClient } from "../../migration/source";
import type { SourceCredential } from "../../migration/source";
import type { SourceApplication, SourceCompose } from "../../migration/model";
import {
  mapBuildSettings,
  mapPorts,
  unsupportedNotes,
} from "../../migration/map/app-settings";
import {
  cloneTarget,
  composeRegistryNotes,
  mapSource,
} from "../../migration/map/app-source";
import {
  adaptComposeForDeplo,
  retargetPlatformEnvFiles,
} from "../../migration/map/compose-adapt";
import {
  type ComposeRepoApp,
  composeBuildServices,
} from "../../migration/map/compose-read";
import { renameClashingServices } from "../../migration/map/compose-rename";
import type { MappedDomain } from "../../migration/map/domains";
import { renameHostTokens } from "../../migration/map/env";
import type { MappedMounts } from "../../migration/map/mounts";
import { composeNamesOnNetwork } from "../../deploy/compose-stack/compose-read";
import { composeHostPorts } from "../../deploy/compose-lint/host-ports";
import { canExposePorts, requireActiveTeamId } from "../../membership";
import type { BuildConfig } from "../../types/build";
import type { PublishedPort } from "../../types/container";
import { createApp } from "../apps/create";
import { namesTakenOnNetwork } from "../name-clash";
import {
  composeAdvice,
  composePlatform,
  composeServiceCount,
} from "./compose-notes";
import type { Report } from "./run-report";
import type { SourceService } from "./source-tree";
import { landingServerId } from "./target-servers";

export async function loadComposeText(
  c: SourceCredential,
  svc: SourceService,
  detail: SourceApplication & SourceCompose,
  name: string,
  report: Report,
): Promise<string | null> {
  const inline = (detail.composeFile ?? "").trim();
  const yamlText =
    inline || (await sourceClient(c).getResolvedCompose(svc.id)) || "";
  if (!yamlText.trim()) {
    await report.add({
      sourceKind: svc.kind,
      sourceId: svc.id,
      sourceName: name,
      outcome: "failed",
      targetKind: "app",
      // That panel keeps every stack's compose on the resource itself and has no resolved-file endpoint.
      message:
        sourceClient(c).platform === "coolify"
          ? "{panel} handed over no compose file for this stack. A token without root is what usually does that - mint one with it and import again. Otherwise create the app and paste the compose in."
          : "The compose file is in a git repository and {panel} would not hand over the resolved file. Create the app and paste the compose in.",
    });
    return null;
  }
  return yamlText;
}

export async function resolveAppSource(
  c: SourceCredential,
  svc: SourceService,
  detail: SourceApplication & SourceCompose,
  name: string,
  home: { environmentId: string; serverId: string | undefined },
  shape: {
    isCompose: boolean;
    yamlText: string;
    asRepoApp: ComposeRepoApp | null;
    repoTarget: ReturnType<typeof cloneTarget> | null;
    domains: { value: MappedDomain[] };
    mounts: { value: MappedMounts };
    env: { key: string; value: string }[];
  },
  notes: string[],
) {
  const { isCompose, yamlText, asRepoApp, repoTarget, domains, mounts, env } =
    shape;
  let serviceRenames = new Map<string, string>();
  let source: Parameters<typeof createApp>[0]["source"] = "upload";
  let repo: Parameters<typeof createApp>[0]["repo"] = null;
  let dockerImage: string | null = null;
  let compose: string | null = null;
  let ports: PublishedPort[] = [];
  const build: Partial<BuildConfig> = {};

  if (asRepoApp && repoTarget) {
    source = repoTarget.provider === "github" ? "github" : "git";
    repo = repoTarget;
    build.buildMethod = "dockerfile";
    build.methodSettings = {
      dockerfilePath: asRepoApp.dockerfilePath ?? "Dockerfile",
      ...(asRepoApp.dockerContextPath
        ? { dockerContextPath: asRepoApp.dockerContextPath }
        : {}),
      ...(asRepoApp.dockerBuildStage
        ? { dockerBuildStage: asRepoApp.dockerBuildStage }
        : {}),
    };
    notes.push(
      `On {panel} this was a compose file in ${repoTarget.repo}, and all it did was build that repository and run it - so it came across as an app built from ${repoTarget.repo}, not as a stack. Pushing to ${repoTarget.branch} deploys it.`,
    );
  } else if (isCompose) {
    source = "compose";
    const inline = (detail.composeFile ?? "").trim();
    if (!inline)
      notes.push(
        "The compose file is kept inline from now on, so changes in the repository will not follow.",
      );
    const adapted = adaptComposeForDeplo(yamlText, composePlatform(c, svc));
    const retargeted = retargetPlatformEnvFiles(
      adapted.compose,
      mounts.value.files.map((f) => f.filePath),
    );
    compose = retargeted.compose;
    notes.push(
      ...adapted.changes,
      ...retargeted.changes,
      ...composeRegistryNotes(compose),
    );
    const takenNames = await namesTakenOnNetwork({
      teamId: await requireActiveTeamId(),
      environmentId: home.environmentId,
      serverId: await landingServerId(home.serverId),
    });
    const mine = new Set(composeNamesOnNetwork(compose));
    // One network per Environment (ADR-0028), so two stacks that both call their database db collide.
    const renamed = renameClashingServices(
      compose,
      new Set([...takenNames].filter((n) => mine.has(n))),
      name,
      takenNames,
    );
    if (renamed.renames.size > 0) {
      compose = renamed.compose;
      notes.push(...renamed.changes);
      for (const d of domains.value) {
        const to = d.service && renamed.renames.get(d.service.toLowerCase());
        if (to) d.service = to;
      }
      serviceRenames = renamed.renames;
      renameHostTokens(env, renamed.renames);
    }
    notes.push(...composeAdvice(compose));
    const builders = composeBuildServices(compose);
    if (builders.length > 0)
      notes.push(
        `${builders.join(", ")} ${builders.length === 1 ? "builds" : "build"} from source, and Deplo has no repository for this stack - only the compose file came over. Give ${builders.length === 1 ? "it an" : "them"} image, or split ${builders.length === 1 ? "it" : "them"} out into ${builders.length === 1 ? "its" : "their"} own app built from the repository.`,
      );
    const services = composeServiceCount(compose);
    if (services === null)
      notes.push(
        "Its compose file is not valid YAML, so it came across exactly as it is - nothing here rewrote it. Fix it under Compose before deploying.",
      );
    else if (services === 0)
      notes.push(
        "Its compose file declares no services, so there is nothing to deploy yet. Add them under Compose.",
      );
    if (/^\s*env_file\s*:/m.test(compose) && home.serverId) {
      const { serverSupports } =
        await import("../../infra/agent-client/preflight");
      const { COMPOSE_PROJECTDIR_CAPABILITY } =
        await import("../../infra/agent-client/hello-capabilities");
      if (!(await serverSupports(home.serverId, COMPOSE_PROJECTDIR_CAPABILITY)))
        notes.push(
          "Its compose file names an `env_file`, which needs a newer agent on this server than the one running there. Update the server's agent under Servers before deploying.",
        );
    }
    const wantedPorts = composeHostPorts(compose);
    if (wantedPorts.length > 0 && home.serverId && (await canExposePorts())) {
      try {
        const { hostPortsInUse } = await import("../databases/server-ports");
        const probe = await hostPortsInUse(home.serverId, wantedPorts);
        if (probe.checked && probe.inUse.length > 0)
          notes.push(
            `It publishes ${probe.inUse.join(", ")} on the host, and ${probe.inUse.length === 1 ? "that port is" : "those ports are"} already taken on this server - the stack will not start until you change ${probe.inUse.length === 1 ? "it" : "them"} under Compose.`,
          );
      } catch {}
    }
    if (detail.isolatedDeployment)
      notes.push(
        "{panel} isolates this stack's network and volume names. Deplo does that for every stack - check the service names it talks to.",
      );
  } else {
    const app = detail as SourceApplication;
    const mapped = mapSource(app);
    notes.push(...mapped.notes);
    if (mapped.value.kind === "git") {
      source = mapped.value.repo.provider === "github" ? "github" : "git";
      repo = mapped.value.repo;
    } else if (mapped.value.kind === "docker-image") {
      source = "docker-image";
      dockerImage = mapped.value.image;
    } else {
      source = "upload";
      const watched = (app.watchPaths ?? []).filter((p) => p.trim());
      notes.push(
        "Set the source under the app's Source settings before deploying." +
          (watched.length > 0
            ? ` It only deployed on changes under ${watched.join(", ")} - set those again once the repository is there.`
            : ""),
      );
    }
    const mappedBuild = mapBuildSettings(app);
    notes.push(...mappedBuild.notes);
    Object.assign(build, mappedBuild.value);
    const mappedPorts = mapPorts(app);
    ports = mappedPorts.value;
    notes.push(...mappedPorts.notes);
    notes.push(...unsupportedNotes(app));
  }

  return { serviceRenames, source, repo, dockerImage, compose, ports, build };
}

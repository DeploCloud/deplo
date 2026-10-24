import "server-only";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { appIconProbeTarget } from "../../apps/favicon-detect";
import { loadAppGraph, loadDeployment } from "../../data/app-graph-load";
import { finalizeDeploymentLogs } from "../../data/deployment-logs";
import { primaryDomainName } from "../../data/domains/primary-domain";
import { getDb } from "../../db/client";
import {
  deployments as deploymentsTable,
  appPreviews as appPreviewsTable,
} from "../../db/schema/control-plane/deployments";
import { normalizeBuildConfig } from "../../frameworks";
import { forkCloneUrl, resolveCloneUrl } from "../../git/clone-url";
import { repoCloneRefusal } from "../../git/repo-access";
import { buildMetadataToken, publicBranchHead } from "../../github/app";
import {
  adoptObservedPort,
  recordResolvedMethod,
  recordSourceCompose,
} from "../../data/apps/build-outcome";
import type { SourceCompose } from "../../agent/gen/agent";
import { findComposeFile, resolveUploadMethod } from "../agent-deploy";
import {
  composeBuildsFromSource,
  composeOnlyRunsImages,
} from "./source-compose";
import { readFile } from "node:fs/promises";
import { publishAppChanged } from "../../graphql/pubsub";
import { nowIso } from "../../ids";
import type { CertProvider } from "../../types/domain";
import { usesPastedCompose } from "../../utils";
import { deployImageRef, isOwnImage, stackName } from "../deploy-key";
import { planDeploySource, resolveBuildDir, type SourcePlan } from "../source";
import { extractArchive } from "../upload";
import {
  autoDetectComposeLogo,
  autoDetectFrameworkFromTree,
  autoDetectLogoFromTree,
  autoDetectRepoFramework,
  autoDetectRepoLogo,
  canRecognizeFramework,
  setFramework,
} from "./auto-detect";
import {
  assertBuildMethodCapability,
  consumeCacheClear,
  noCacheForDeploy,
  resolveBuildServerOpts,
  tryAgent,
} from "./build-attempt";
import { renderDeployStack } from "./compose-render";
import {
  deployComposeStackViaAgent,
  deploySourceComposeStack,
} from "./compose-stack-deploy";
import { readyCheckFor } from "./ready-check";
import { rerouteApp } from "./reroute";
import type { PreviewEnvContext } from "./deploy-env";
import { previewRouteTarget, routableForDeploy } from "./deploy-routes";
import { applyDomainEditsMadeDuringBuild } from "./domain-edits-during-build";
import {
  commitOutcome,
  log,
  setDep,
  setDeployState,
  settleIfCanceled,
  settleMove,
  sweepAfterDeploy,
  targetFor,
} from "./deployment-state";
import { destroyStack } from "./stack-lifecycle";

function forkFullName(cloneUrl: string): string {
  try {
    return new URL(cloneUrl).pathname.replace(/^\/+/, "").replace(/\.git$/, "");
  } catch {
    return "";
  }
}

async function loadPreviewForDeploy(previewId: string): Promise<{
  id: string;
  host: string;
  certProvider: CertProvider;
  prNumber: number;
  isFork: boolean;
  headCloneUrl: string;
  approvedSha: string | null;
  port: number | null;
} | null> {
  const rows = await getDb()
    .select({
      id: appPreviewsTable.id,
      host: appPreviewsTable.host,
      certProvider: appPreviewsTable.certProvider,
      prNumber: appPreviewsTable.prNumber,
      isFork: appPreviewsTable.isFork,
      headCloneUrl: appPreviewsTable.headCloneUrl,
      approvedSha: appPreviewsTable.approvedSha,
      port: appPreviewsTable.port,
    })
    .from(appPreviewsTable)
    .where(eq(appPreviewsTable.id, previewId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { ...row, certProvider: row.certProvider as CertProvider };
}

const MAX_SOURCE_COMPOSE_BYTES = 512 * 1024;

async function readUploadCompose(
  buildDir: string,
  preferred?: string | null,
): Promise<SourceCompose> {
  const path = await findComposeFile(buildDir, preferred);
  if (!path)
    throw new Error(
      `No ${preferred?.trim() || "docker-compose.yml"} in the uploaded files.`,
    );
  const content = await readFile(join(buildDir, path), "utf8");
  if (Buffer.byteLength(content) > MAX_SOURCE_COMPOSE_BYTES)
    throw new Error(`${path} is larger than 512 KB.`);
  return { path, content };
}

export async function runDeploymentGuarded(depId: string): Promise<void> {
  try {
    await runDeployment(depId);
  } catch (e) {
    log(depId, "error", e instanceof Error ? e.message : String(e));
    await setDep(depId, { status: "error" }, { onlyIfNotCanceled: true });
    await finalizeDeploymentLogs(depId);
  }
}

async function runDeployment(depId: string): Promise<void> {
  const started = Date.now();
  const dep = await loadDeployment(depId);
  if (!dep) return;
  const project = await loadAppGraph(dep.appId);
  if (!project) {
    await setDep(depId, { status: "error" }, { onlyIfNotCanceled: true });
    return;
  }
  const deployKey = dep.deployKey || project.slug;
  const preview = dep.previewId
    ? await loadPreviewForDeploy(dep.previewId)
    : null;
  const name = stackName(deployKey);
  const runServerId = dep.serverId || project.serverId;
  const target = targetFor(dep, project);
  const trackingId = preview ? preview.id : project.id;
  const domain = preview ? preview.host : await primaryDomainName(project.id);
  // A preview host is never a `domains` row: it would leak into the production routers and cert quota.
  const routeDomains = await routableForDeploy(
    project.id,
    dep.environment,
    domain,
    preview?.certProvider,
    preview ? await previewRouteTarget(project, preview.port) : undefined,
  );

  const previewCtx: PreviewEnvContext | null = preview
    ? {
        host: domain,
        url: dep.url,
        branch: dep.branch,
        prNumber: preview.prNumber,
        isFork: preview.isFork,
      }
    : null;

  // Claim only while still queued - the terminal CAS covers a cancel during the build, not before it.
  const claimed = await getDb()
    .update(deploymentsTable)
    .set({ status: "building", startedAt: new Date(started).toISOString() })
    .where(
      and(
        eq(deploymentsTable.id, depId),
        eq(deploymentsTable.status, "queued"),
      ),
    )
    .returning({ id: deploymentsTable.id });
  if (claimed.length === 0) {
    await settleIfCanceled(depId, target);
    await finalizeDeploymentLogs(depId);
    return;
  }
  publishAppChanged(project.id);
  if (!(await setDeployState(target, { status: "building" }))) {
    log(depId, "warn", "This preview was stopped before its build started.");
    await setDep(depId, { status: "canceled" });
    await finalizeDeploymentLogs(depId);
    return;
  }

  try {
    // Nothing host-local happens here: every build method runs on the agent (ADR-0006).
    const { noCache, reason: noCacheReason } = noCacheForDeploy(project.build);
    const forceRecreate = dep.forceRecreate;

    const hasCompose = Boolean(project.compose && project.compose.trim());
    // A stack read from the app's own source goes through the git/upload path below, which reads it again.
    const useCompose = usesPastedCompose(project);
    if (useCompose && dep.rollbackOf) {
      log(
        depId,
        "error",
        "This app deploys a compose stack now, so there is no single image to roll back to.",
      );
      await commitOutcome(
        depId,
        target,
        { status: "error", buildDurationMs: Date.now() - started },
        { status: "error" },
      );
      return;
    }
    if (useCompose && hasCompose) {
      const composeOpts = {
        depId,
        project,
        name,
        deployKey,
        trackingId,
        target,
        domain,
        forceRecreate,
        domains: routeDomains.map((d) => d.name),
        domainRoutes: routeDomains,
        environment: dep.environment,
        preview: previewCtx,
        started,
      };
      await deployComposeStackViaAgent({
        ...composeOpts,
        serverId: runServerId,
      });
      if (!preview) {
        autoDetectComposeLogo(
          project.id,
          project.logo,
          project.serverId,
          deployKey,
          appIconProbeTarget(project, routeDomains, domain),
        );
      }
      return;
    }

    let imageRef: string;
    let commitSha = "";
    // "stack": the source's compose file was deployed, and that path committed the outcome itself.
    let agentOutcome: "agent" | "failed" | "stack" | null = null;
    const serverId = runServerId;
    const agentProject = {
      id: project.id,
      deployKey,
      composeUpArgs: project.composeUpArgs,
    };

    // A rollback that carries another deployment's image re-runs it; one with none rebuilds its commit.
    const instantRollback = Boolean(
      dep.rollbackOf && dep.imageRef && !isOwnImage(dep.imageRef, dep.id),
    );
    const rebuildCommit =
      dep.rollbackOf && !instantRollback ? dep.commitSha : "";

    const method = normalizeBuildConfig(project.build);
    const stackFromSource =
      method.buildMethod === "compose" && !method.methodAuto;
    const buildServerOpts = stackFromSource
      ? {
          builders: [],
          localAllowed: true,
          targetServerName: "",
          planLines: [],
        }
      : await resolveBuildServerOpts(project, serverId, instantRollback);
    const ready = readyCheckFor({
      routes: routeDomains,
      appPort: preview?.port ?? project.build.port,
    });
    const usesRailpack = method.methodAuto || method.buildMethod === "railpack";

    if (
      !(await assertBuildMethodCapability({
        depId,
        target,
        build: project.build,
        rollback: instantRollback,
        onBuildServer: Boolean(dep.buildServerId),
        builders: buildServerOpts.builders,
        serverId,
        started,
      }))
    )
      return;

    let observedPort: number | undefined;
    // The source carried a compose file: the stack deploy commits its own outcome.
    const deployStackFrom = async (
      found: SourceCompose,
      source: Parameters<typeof deploySourceComposeStack>[0]["source"],
    ): Promise<void> => {
      if (preview) {
        log(
          depId,
          "error",
          "Preview environments are not available yet for an app deployed from its Docker Compose file.",
        );
        await commitOutcome(
          depId,
          target,
          { status: "error", buildDurationMs: Date.now() - started },
          { status: "error" },
        );
        return;
      }
      // A stack has no single image: a rollback to this deployment rebuilds its commit instead.
      await setDep(depId, { imageRef: null });
      if (method.methodAuto) {
        log(
          depId,
          "info",
          `Found ${found.path}: deploying it as a stack (Detect automatically).`,
        );
        await recordResolvedMethod(project.id, "compose");
      }
      const outcome = await deploySourceComposeStack({
        depId,
        project,
        name,
        deployKey,
        trackingId,
        target,
        domain,
        forceRecreate,
        domains: routeDomains.map((d) => d.name),
        domainRoutes: routeDomains,
        environment: dep.environment,
        preview: previewCtx,
        started,
        serverId,
        rawCompose: found.content,
        composeFile: found.path,
        source,
        subdir: project.build.rootDirectory ?? "",
        tag: depId
          .replace(/[^a-zA-Z0-9]/g, "")
          .slice(-12)
          .toLowerCase(),
      });
      if (outcome.deployed && outcome.observedPort)
        await adoptPort(
          outcome.observedPort,
          outcome.service ?? null,
          outcome.checkedPort,
        );
    };
    // Runs after the deploy is committed ready, so nothing here may throw past it.
    const adoptPort = async (
      to: number,
      service: string | null,
      from = ready.port,
    ) => {
      if (preview || !to || to === from) return;
      log(
        depId,
        "info",
        `Your app listens on port ${to}, not ${from}: Deplo now sends its traffic to ${to}.`,
      );
      try {
        await adoptObservedPort(project.id, { from, to, service });
        await rerouteApp(project.id);
      } catch (e) {
        log(
          depId,
          "warn",
          `Could not move the domain to port ${to} yet: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    };
    // A single image runs now: a stack read from the source before is gone, whatever the method.
    const settleSingleImage = async (builtWith?: string) => {
      if (hasCompose && !useCompose)
        await recordSourceCompose(project.id, null);
      if (!method.methodAuto) return;
      await recordResolvedMethod(
        project.id,
        builtWith === "dockerfile" ? "dockerfile" : "railpack",
      );
    };

    const renderStack = (image: string) =>
      renderDeployStack({
        project,
        name,
        deployKey,
        trackingId,
        environment: dep.environment,
        preview: previewCtx,
        previewPort: preview?.port ?? null,
        routes: routeDomains,
        image,
      });

    const buildAndMaybeAgent = async (treeOpts: {
      workDir: string;
      root: string;
      imageRef: string;
      failOnMissing: boolean;
      notFoundMessage?: string;
    }): Promise<void> => {
      const buildDir = await resolveBuildDir({
        root: treeOpts.root,
        rootDirectory: project.build.rootDirectory,
        failOnMissing: treeOpts.failOnMissing,
        notFoundMessage: treeOpts.notFoundMessage,
      });
      // The upload is here already, so Detect automatically reads its files before anything is sent.
      const build = await resolveUploadMethod(buildDir, project.build);
      if (build.buildMethod === "compose") {
        const found = await readUploadCompose(
          buildDir,
          build.methodSettings.composeFile,
        );
        agentOutcome = "stack";
        await deployStackFrom(found, { kind: "upload", buildDir });
        return;
      }
      if (method.methodAuto && build.buildMethod === "railpack") {
        const compose = await findComposeFile(
          buildDir,
          project.build.methodSettings.composeFile,
        );
        if (compose) log(depId, "info", composeOnlyRunsImages(compose));
      }
      if (method.methodAuto && build.buildMethod === "dockerfile")
        log(
          depId,
          "info",
          "Found a Dockerfile: building it (Detect automatically).",
        );
      const { composeYaml, env, network } = await renderStack(
        treeOpts.imageRef,
      );
      const attempt = await tryAgent({
        depId,
        serverId,
        project: agentProject,
        imageRef: treeOpts.imageRef,
        composeYaml,
        network,
        env,
        plan: { kind: "dockerfile", buildDir, build },
        noCache,
        forceRecreate,
        ready,
        githubToken:
          build.buildMethod === "railpack"
            ? ((await buildMetadataToken(project.teamId)) ?? undefined)
            : undefined,
        ...buildServerOpts,
      });
      agentOutcome = attempt.outcome === "agent" ? "agent" : "failed";
      observedPort = attempt.observedPort;
      if (attempt.outcome === "agent")
        await settleSingleImage(build.buildMethod);
    };

    if (!canRecognizeFramework(project)) void setFramework(project.id, null);

    const plan: SourcePlan | { kind: "rollback"; image: string; of: string } =
      instantRollback && dep.imageRef && dep.rollbackOf
        ? { kind: "rollback", image: dep.imageRef, of: dep.rollbackOf }
        : planDeploySource(project);
    if (
      dep.rollbackOf &&
      !instantRollback &&
      (plan.kind !== "git" || !rebuildCommit)
    )
      throw new Error(
        "This app no longer deploys from a repository, so the commit of that deployment can't be rebuilt.",
      );
    if (noCache && (plan.kind === "git" || plan.kind === "upload")) {
      log(depId, "info", noCacheReason);
      if (project.build.buildCacheClearPending)
        await consumeCacheClear(project.id);
    }
    switch (plan.kind) {
      case "rollback": {
        imageRef = plan.image;
        log(
          depId,
          "info",
          `Rolling back to the image from deployment ${plan.of}`,
        );
        const { composeYaml, env, network } = await renderStack(imageRef);
        const { outcome } = await tryAgent({
          depId,
          serverId,
          project: agentProject,
          imageRef,
          composeYaml,
          network,
          env,
          plan: { kind: "image", image: imageRef, pull: false },
          forceRecreate,
          ready,
        });
        agentOutcome = outcome === "agent" ? "agent" : "failed";
        // The image runs again, so a stack read from the source since then no longer does.
        if (outcome === "agent" && hasCompose && !useCompose)
          await recordSourceCompose(project.id, null);
        break;
      }
      case "docker-image": {
        imageRef = plan.image;
        const { composeYaml, env, network } = await renderStack(imageRef);
        const { outcome } = await tryAgent({
          depId,
          serverId,
          project: agentProject,
          imageRef,
          composeYaml,
          network,
          env,
          plan: { kind: "image", image: plan.image, pull: true },
          forceRecreate,
          ready,
        });
        agentOutcome = outcome === "agent" ? "agent" : "failed";
        break;
      }
      case "git": {
        const repo = plan.repo;
        if (preview && stackFromSource)
          throw new Error(
            "Preview environments are not available yet for an app deployed from its Docker Compose file.",
          );
        autoDetectRepoLogo(
          project.id,
          project.logo,
          repo,
          project.build.rootDirectory,
        );
        if (canRecognizeFramework(project)) {
          autoDetectRepoFramework(
            project.id,
            repo,
            project.build.rootDirectory,
          );
        }
        const forkUrl = preview?.isFork
          ? forkCloneUrl(repo.url, preview.headCloneUrl)
          : null;
        if (!forkUrl) {
          const refusal = await repoCloneRefusal(repo);
          if (refusal) throw new Error(refusal);
        }
        const cloneUrl = forkUrl ?? (await resolveCloneUrl(repo));
        // A fork builds the commit that was approved, never whatever its branch holds when the agent clones.
        const forkSha = forkUrl ? preview?.approvedSha : null;
        if (forkUrl && !forkSha)
          throw new Error("Approve this fork pull request before building it");
        const pin = forkSha || rebuildCommit;
        if (forkUrl && preview?.approvedSha) {
          const tip = await publicBranchHead(
            forkFullName(preview.headCloneUrl),
            dep.branch,
          );
          if (tip && tip !== preview.approvedSha)
            throw new Error(
              `The fork's branch moved past the reviewed commit (${preview.approvedSha.slice(0, 7)} → ${tip.slice(0, 7)}). Approve the new commit to build it.`,
            );
        }
        imageRef = deployImageRef(deployKey, depId);
        await setDep(depId, { imageRef });
        const rendered = await renderStack(imageRef);
        // An explicit compose method first only reads the file at this commit: there is no image stack yet.
        const composeYaml = stackFromSource ? "" : rendered.composeYaml;
        const { env, network } = rendered;
        log(
          depId,
          "command",
          pin
            ? `git fetch ${forkUrl ?? repo.url} (${pin.slice(0, 7)}) [on agent]`
            : `git clone ${forkUrl ?? repo.url} (${dep.branch}) [on agent]`,
        );
        const githubToken =
          usesRailpack && !forkUrl
            ? ((await buildMetadataToken(
                project.teamId,
                repo.installationId ?? null,
              )) ?? undefined)
            : undefined;
        const gitLeg = (
          build: typeof project.build,
          commit: string,
          agentDeployId?: string,
        ) =>
          tryAgent({
            depId,
            serverId,
            project: agentProject,
            imageRef,
            composeYaml,
            network,
            env,
            plan: {
              kind: "git",
              url: cloneUrl,
              branch: dep.branch,
              commit: commit || undefined,
              subdir: project.build.rootDirectory ?? "",
              submodules: Boolean(repo.submodules),
              build: normalizeBuildConfig(build),
            },
            noCache,
            forceRecreate,
            forkPreview: Boolean(forkUrl),
            ready,
            // A fork is a stranger's code: its build never borrows the team's GitHub identity.
            githubToken,
            agentDeployId,
            ...buildServerOpts,
          });
        let attempt = await gitLeg(project.build, pin);
        if (attempt.commitSha) {
          commitSha = attempt.commitSha;
          await setDep(depId, { commitSha });
          if (
            forkUrl &&
            preview?.approvedSha &&
            attempt.commitSha !== preview.approvedSha
          ) {
            log(
              depId,
              "error",
              `The fork's branch moved past the reviewed commit (${preview.approvedSha.slice(0, 7)} → ${attempt.commitSha.slice(0, 7)}); the stack was taken down. Approve the new commit to build it.`,
            );
            await destroyStack(deployKey, { removeVolumes: true }).catch(
              () => {},
            );
            throw new Error(
              "The fork's branch moved past the reviewed commit.",
            );
          }
        }
        // Detect automatically takes a compose file only when it builds this repository's code.
        if (
          attempt.sourceCompose &&
          method.methodAuto &&
          !composeBuildsFromSource(attempt.sourceCompose.content)
        ) {
          log(depId, "info", composeOnlyRunsImages(attempt.sourceCompose.path));
          attempt = await gitLeg(
            { ...project.build, buildMethod: "railpack", methodAuto: false },
            attempt.commitSha || pin,
            `${depId}-railpack`,
          );
        }
        if (attempt.sourceCompose) {
          agentOutcome = "stack";
          await deployStackFrom(attempt.sourceCompose, {
            kind: "git",
            url: cloneUrl,
            commit: attempt.commitSha || pin,
            subdir: project.build.rootDirectory ?? "",
            submodules: Boolean(repo.submodules),
          });
          break;
        }
        agentOutcome = attempt.outcome === "agent" ? "agent" : "failed";
        observedPort = attempt.observedPort;
        if (attempt.outcome === "agent")
          await settleSingleImage(attempt.builtWith);
        break;
      }
      case "upload": {
        const upload = plan.upload;
        const work = await mkdtemp(join(tmpdir(), "deplo-build-"));
        try {
          log(depId, "command", `extract ${upload.filename}`);
          const root = await extractArchive(upload, work, (line) =>
            log(depId, "info", line),
          );
          imageRef = deployImageRef(deployKey, depId);
          await setDep(depId, { imageRef });
          await autoDetectLogoFromTree(
            project.id,
            project.logo,
            root,
            project.build.rootDirectory,
          );
          if (canRecognizeFramework(project)) {
            await autoDetectFrameworkFromTree(
              project.id,
              root,
              project.build.rootDirectory,
            );
          }
          await buildAndMaybeAgent({
            workDir: work,
            root,
            imageRef,
            failOnMissing: false,
          });
        } finally {
          await rm(work, { recursive: true, force: true }).catch(() => {});
        }
        break;
      }
      default:
        throw new Error("Nothing to deploy: no Docker image or repository set");
    }

    if (agentOutcome === "stack") return;
    const buildDurationMs = Date.now() - started;
    if (agentOutcome === "agent") {
      const applied = await commitOutcome(
        depId,
        target,
        {
          status: "ready",
          readyAt: nowIso(),
          buildDurationMs,
          commitSha: commitSha || dep.commitSha,
        },
        {
          status: "active",
          ...(dep.environment === "production"
            ? { productionUrl: dep.url || null }
            : {}),
        },
        { rollback: Boolean(dep.rollbackOf) },
      );
      if (applied) {
        log(
          depId,
          "success",
          dep.url
            ? `Deployment ready at ${dep.url}`
            : "Deployment ready (no domain - add one to route traffic)",
        );
        if (observedPort) await adoptPort(observedPort, null);
        if (dep.environment === "production") {
          await settleMove(depId, project.id, serverId);
        }
        sweepAfterDeploy(depId, serverId);
      }
    } else {
      await commitOutcome(
        depId,
        target,
        { status: "error", buildDurationMs },
        { status: "error" },
      );
    }
  } catch (e) {
    log(depId, "error", e instanceof Error ? e.message : String(e));
    await commitOutcome(
      depId,
      target,
      { status: "error", buildDurationMs: Date.now() - started },
      { status: "error" },
    );
  } finally {
    if (!preview && dep.environment === "production")
      await applyDomainEditsMadeDuringBuild(depId, project.id, routeDomains);
    await finalizeDeploymentLogs(depId);
  }
}

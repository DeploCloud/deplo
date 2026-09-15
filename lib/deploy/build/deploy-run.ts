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
import { publicBranchHead } from "../../github/app";
import { publishAppChanged } from "../../graphql/pubsub";
import { nowIso } from "../../ids";
import type { CertProvider } from "../../types/domain";
import { usesComposeStack } from "../../utils";
import { deployImageRef, stackName } from "../deploy-key";
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
import { deployComposeStackViaAgent } from "./compose-stack-deploy";
import type { PreviewEnvContext } from "./deploy-env";
import { previewRouteTarget, routableForDeploy } from "./deploy-routes";
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
    const { noCache, reason: noCacheReason } = noCacheForDeploy(project.build);
    const forceRecreate = dep.forceRecreate;

    const hasCompose = Boolean(project.compose && project.compose.trim());
    const useCompose = usesComposeStack(project);
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
    let agentOutcome: "agent" | "failed" | null = null;
    const serverId = runServerId;
    const agentProject = {
      id: project.id,
      deployKey,
      composeUpArgs: project.composeUpArgs,
    };

    const buildServerOpts = await resolveBuildServerOpts(
      project,
      serverId,
      Boolean(dep.rollbackOf),
    );

    if (
      !(await assertBuildMethodCapability({
        depId,
        target,
        build: project.build,
        rollback: Boolean(dep.rollbackOf),
        onBuildServer: Boolean(dep.buildServerId),
        builders: buildServerOpts.builders,
        serverId,
        started,
      }))
    )
      return;

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
      const { composeYaml, env, network } = await renderStack(
        treeOpts.imageRef,
      );
      const { outcome } = await tryAgent({
        depId,
        serverId,
        project: agentProject,
        imageRef: treeOpts.imageRef,
        composeYaml,
        network,
        env,
        plan: {
          kind: "dockerfile",
          buildDir,
          build: normalizeBuildConfig(project.build),
        },
        noCache,
        forceRecreate,
        ...buildServerOpts,
      });
      agentOutcome = outcome === "agent" ? "agent" : "failed";
    };

    if (!canRecognizeFramework(project)) void setFramework(project.id, null);

    const plan: SourcePlan | { kind: "rollback"; image: string; of: string } =
      dep.rollbackOf && dep.imageRef
        ? { kind: "rollback", image: dep.imageRef, of: dep.rollbackOf }
        : planDeploySource(project);
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
        });
        agentOutcome = outcome === "agent" ? "agent" : "failed";
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
        });
        agentOutcome = outcome === "agent" ? "agent" : "failed";
        break;
      }
      case "git": {
        const repo = plan.repo;
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
        const { composeYaml, env, network } = await renderStack(imageRef);
        log(
          depId,
          "command",
          `git clone ${forkUrl ?? repo.url} (${dep.branch}) [on agent]`,
        );
        const attempt = await tryAgent({
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
            subdir: project.build.rootDirectory ?? "",
            build: normalizeBuildConfig(project.build),
          },
          noCache,
          forceRecreate,
          forkPreview: Boolean(forkUrl),
          ...buildServerOpts,
        });
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
        agentOutcome = attempt.outcome === "agent" ? "agent" : "failed";
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
        if (dep.environment === "production") {
          await settleMove(depId, project.id, serverId);
        }
        await sweepAfterDeploy(depId, serverId);
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
    await finalizeDeploymentLogs(depId);
  }
}

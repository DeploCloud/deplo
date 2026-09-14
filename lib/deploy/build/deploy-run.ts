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

// `owner/repo` from a GitHub clone URL, or "" when it does not read as one.
function forkFullName(cloneUrl: string): string {
  try {
    return new URL(cloneUrl).pathname.replace(/^\/+/, "").replace(/\.git$/, "");
  } catch {
    return "";
  }
}

// The bits of a pull request preview a running deploy needs: the host it routes on and the
// certificate provider that host was minted with.
async function loadPreviewForDeploy(previewId: string): Promise<{
  id: string;
  host: string;
  certProvider: CertProvider;
  prNumber: number;
  isFork: boolean;
  headCloneUrl: string;
  // The commit a person reviewed - the only one a fork may be built at.
  approvedSha: string | null;
  // Frozen at creation from the app's `preview_port`. NULL => the build port.
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

// runDeploymentGuarded runs a queued deployment for the deploy queue, flushing a clean
// terminal error if `runDeployment`'s pre-try setup throws.
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
  // THE stack this deploy owns.
  const deployKey = dep.deployKey || project.slug;
  const preview = dep.previewId
    ? await loadPreviewForDeploy(dep.previewId)
    : null;
  const name = stackName(deployKey);
  // The row, not the app: a preview may be pinned to a different machine, and the row is
  // what the queue already drained on.
  const runServerId = dep.serverId || project.serverId;
  const target = targetFor(dep, project);
  // The `deplo.project` label value: an App id for production, the PREVIEW's own id for a
  // preview.
  const trackingId = preview ? preview.id : project.id;
  const domain = preview ? preview.host : await primaryDomainName(project.id);
  // A preview routes only to its own host, which is never a registered `domains` row: that
  // would leak it into the PRODUCTION router set and into the per-team certificate quota.
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

  // Claim the deploy: queued -> building, but ONLY while it is still queued. The terminal
  // CAS only covers a cancel arriving DURING the build; this covers the window before it.
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
    // Evicted, blocked or closed while it waited in the queue: building it now would only
    // bring up a stack the row already says is gone.
    log(depId, "warn", "This preview was stopped before its build started.");
    await setDep(depId, { status: "canceled" });
    await finalizeDeploymentLogs(depId);
    return;
  }

  try {
    // Nothing host-local happens here, and that is the point: every build method runs on
    // the agent (ADR-0006).
    const { noCache, reason: noCacheReason } = noCacheForDeploy(project.build);
    const forceRecreate = dep.forceRecreate;

    const hasCompose = Boolean(project.compose && project.compose.trim());
    const useCompose = usesComposeStack(project);
    // A ROLLBACK must never reach the compose branch: it would bring the CURRENT stack up,
    // settle `ready`, and report success for something that did not happen.
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
      // PRODUCTION ONLY: this writes the APP's logo.
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

    // Per-server build-method capability gate: fail with an actionable "update the agent"
    // message rather than letting the build die on the host.
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

    // A BUILT source (git/upload): resolve the build dir (one shared rootDirectory
    // containment), then ship the materialised tree to the agent, which builds + runs it.
    const buildAndMaybeAgent = async (treeOpts: {
      workDir: string;
      root: string;
      imageRef: string;
      // Hard-fail on an explicit-but-missing rootDirectory (git); upload doesn't.
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

    // Framework recognition is per-deploy and self-correcting.
    if (!canRecognizeFramework(project)) void setFramework(project.id, null);

    const plan: SourcePlan | { kind: "rollback"; image: string; of: string } =
      dep.rollbackOf && dep.imageRef
        ? { kind: "rollback", image: dep.imageRef, of: dep.rollbackOf }
        : planDeploySource(project);
    // Spend the one-shot clear where a build is genuinely about to run: a prebuilt image
    // never builds, so its deploy must not swallow the clear armed for the next real one.
    if (noCache && (plan.kind === "git" || plan.kind === "upload")) {
      log(depId, "info", noCacheReason);
      if (project.build.buildCacheClearPending)
        await consumeCacheClear(project.id);
    }
    switch (plan.kind) {
      case "rollback": {
        // Only the IMAGE comes from the past: rolling a password back because the code
        // rolled back is not something anyone asked for.
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
        // A prebuilt image: the owning agent pulls + runs it on its host.
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
        // Via the GitHub API - the tree is cloned on the agent, not here - so a round trip
        // never delays the deploy.
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
        // A fork is built at the ONE commit somebody reviewed, and the clone takes the
        // branch tip. Best-effort: the check after the clone is the one that cannot be dodged.
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
        // One tag per deployment, and the agent builds under exactly this string - it
        // resolves the commit sha but never retags with it.
        imageRef = deployImageRef(deployKey, depId);
        await setDep(depId, { imageRef });
        const { composeYaml, env, network } = await renderStack(imageRef);
        // The credential-free address: `cloneUrl` carries an installation token for a
        // private repo, and a deploy log is readable by anyone with `view_logs`.
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
          // What actually got cloned: a fork whose branch moved between approval and clone
          // is taken straight down again - the review was of another commit.
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
        // extractArchive rejects any symlink in the archive, so none can be followed out of
        // the temp dir, and may return a subdir (a tarball wrapped in one top-level folder).
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
      // commitOutcome's CAS discards this success if a "Stop build" already claimed the
      // row; the ready log and the data-migration hook run only when it actually applied.
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
        // A PRODUCTION deploy that landed on a NEW server copies the data across now that
        // the fresh stack and its empty volumes exist there.
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
    // A cancel that raced the failure wins: commitOutcome's CAS keeps `canceled`.
    await commitOutcome(
      depId,
      target,
      { status: "error", buildDurationMs: Date.now() - started },
      { status: "error" },
    );
  } finally {
    // GUARANTEED final flush: every end path persists the buffered build logs before the
    // fire-and-forget job exits, instead of relying on the periodic timer.
    await finalizeDeploymentLogs(depId);
  }
}

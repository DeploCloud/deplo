import "server-only";

import { and, eq, isNull, ne, or, sql } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { environments as environmentsTable } from "../../db/schema/control-plane/projects";
import {
  canExposePorts,
  hasCapability,
  requireActiveTeamId,
} from "../../membership";
import type { SourceCredential } from "../../migration/source";
import type { SourceApplication, SourceCompose } from "../../migration/model";
import { mapLogo } from "../../migration/map/app-settings";
import { cloneTarget } from "../../migration/map/app-source";
import { composeAsRepoApp } from "../../migration/map/compose-read";
import { mapDomains } from "../../migration/map/domains";
import { mapMounts } from "../../migration/map/mounts";
import { createApp } from "../apps/create";
import { setAppPorts } from "../apps/ports";
import { setAppEnv } from "../env";
import { setSharedVarAppLink } from "../shared-vars/app-links";
import { composeGrantRefusal } from "./compose-notes";
import type { Report } from "./run-report";
import type { SourceService } from "./source-tree";
import type { SharedIndex } from "./shared-vars-import";
import { landSourceBackups } from "./source-backups";
import { landingServerId } from "./target-servers";
import { mapAppEnv } from "./app-env";
import { loadComposeText, resolveAppSource } from "./app-source";
import { rehostAppDomains } from "./app-domains";
import { landAppStorage } from "./app-storage";
import { landAppExtras } from "./app-extras";

// One source application or compose stack becomes one Deplo App, with its env vars,
// config files, domains, volumes, resource limits, basic-auth users and crons.
export async function importAppService(
  c: SourceCredential,
  svc: SourceService,
  detail: SourceApplication & SourceCompose,
  name: string,
  home: {
    projectId: string;
    environmentId: string;
    serverId: string | undefined;
    buildServerId: string | null;
    // The Deplo server that IS the machine it ran on, when there is one.
    sourceHost: string | null;
    // Old database hostname -> the one Deplo gave it, for the connection strings this
    // app's variables still spell out.
    dbHosts: Map<string, string>;
    // The shared variables this import has already written, by key.
    shared: SharedIndex;
    // Backup destination name (lower-case) -> Deplo destination id.
    destinations?: Map<string, string>;
  },
  report: Report,
): Promise<string | null> {
  // Which source table it sat in. Whether it is a STACK here is decided below: a
  // compose service can turn out to be one app built from its own repository, and
  // importing that as a stack produces something that cannot deploy.
  let isCompose = svc.kind === "compose";

  // Already here? Leave it completely alone - a second pass must not re-write
  // someone's configuration behind their back.
  const existing = await getDb()
    .select({ id: appsTable.id, name: appsTable.name })
    .from(appsTable)
    .where(eq(appsTable.environmentId, home.environmentId));
  const match = existing.find(
    (a) => a.name.trim().toLowerCase() === name.trim().toLowerCase(),
  );
  if (match) {
    // The one thing still worth adding: a schedule whose destination was not
    // here on the first pass.
    const extra: string[] = [];
    await landSourceBackups(
      detail.backups,
      home.destinations,
      { kind: "app", id: match.id, name },
      extra,
    );
    await report.add({
      sourceKind: svc.kind,
      sourceId: svc.id,
      sourceName: name,
      outcome: "skipped",
      targetKind: "app",
      targetId: match.id,
      message: [
        "An app with this name is already in this environment.",
        ...extra,
      ].join(" "),
    });
    return match.id;
  }

  const notes: string[] = [
    ...((detail as SourceApplication).platformNotes ?? []),
  ];

  // The same name somewhere ELSE in this team is allowed - staging may share a name with
  // production - but never silent: two apps called the same thing is worth knowing.
  const namesake = (
    await getDb()
      .select({
        slug: appsTable.slug,
        environmentName: environmentsTable.name,
      })
      .from(appsTable)
      .leftJoin(
        environmentsTable,
        eq(environmentsTable.id, appsTable.environmentId),
      )
      .where(
        and(
          eq(appsTable.teamId, await requireActiveTeamId()),
          sql`lower(${appsTable.name}) = ${name.trim().toLowerCase()}`,
          // `NULL <> id` is NULL, not true: an app sitting outside every
          // environment is exactly the one this has to see.
          or(
            isNull(appsTable.environmentId),
            ne(appsTable.environmentId, home.environmentId),
          ),
        ),
      )
      .limit(1)
  )[0];

  const { env, linkable, dropped, secretKeys } = mapAppEnv(detail, home, notes);

  let yamlText = "";
  if (isCompose) {
    const text = await loadComposeText(c, svc, detail, name, report);
    if (text === null) return null;
    yamlText = text;
  }

  // A compose service that is really one app built from its own repository.
  const repoTarget = isCompose ? cloneTarget(detail) : null;
  const asRepoApp = repoTarget ? composeAsRepoApp(yamlText) : null;
  if (asRepoApp) isCompose = false;

  const domains = mapDomains(detail.domains, {
    isCompose,
    fallbackPort: (detail as SourceApplication).routingPort,
    compose: isCompose ? yamlText : null,
  });
  notes.push(...domains.notes);
  // Landing on the machine it ran on (a takeover): the generated name still
  // points here, so the address people already have keeps working.
  if (
    home.sourceHost != null &&
    home.sourceHost === (await landingServerId(home.serverId))
  )
    for (const d of domains.value)
      if (d.generated && !/(^|\.)localhost$/i.test(d.host)) d.generated = false;
  // The app's own address wins the primary slot over a temporary one, whatever order the
  // source kept them in: promoting a throwaway would demote the name people type.
  const primary =
    domains.value.find((d) => !d.generated) ?? domains.value[0] ?? null;
  const mounts = mapMounts(detail.mounts, { isCompose, compose: yamlText });
  notes.push(...mounts.notes);

  const { serviceRenames, source, repo, dockerImage, compose, ports, build } =
    await resolveAppSource(
      c,
      svc,
      detail,
      name,
      home,
      { isCompose, yamlText, asRepoApp, repoTarget, domains, mounts, env },
      notes,
    );

  // The panel keeps the routing port on the domain, Deplo on the build config (a domain
  // may still override it); a platform that records it on the app itself answers when
  // there is no domain to read it off.
  const routingPort =
    primary?.port ?? (detail as SourceApplication).routingPort ?? null;
  if (routingPort) build.port = routingPort;

  // Claiming a hostname needs `manage_domains`, and an import must not turn a missing
  // permission into a failed app: without it the app comes across on a generated host and
  // the report says which names were left behind.
  const mayClaimHosts = await hasCapability("manage_domains");
  // Only a REAL hostname is a claim the permission gates. A throwaway address is
  // re-hosted onto one of Deplo's own either way (`addImportedDomains`), so
  // naming it here would blame a permission for something it never blocked.
  const claimed = domains.value.filter((d) => !d.generated);
  if (!mayClaimHosts && claimed.length > 0)
    notes.push(
      `You don't have permission to manage domains, so ${claimed
        .map((d) => d.host)
        .join(", ")} came across on a generated address instead.`,
    );

  // A stack that reaches the host cannot be written without the grant, and `createApp`
  // is right to refuse it. Said HERE it reads like the line with the remedy a bind mount
  // gets, rather than a failure that names the wrong thing.
  const grantRefusal = compose
    ? await composeGrantRefusal(compose, name)
    : null;
  if (grantRefusal) {
    await report.add({
      sourceKind: svc.kind,
      sourceId: svc.id,
      sourceName: name,
      outcome: "manual",
      targetKind: "app",
      message: grantRefusal,
    });
    return null;
  }

  const created = await createApp({
    name,
    source,
    repo,
    dockerImage,
    compose,
    env,
    serverId: home.serverId,
    buildServerId: home.buildServerId,
    projectId: home.projectId,
    environmentId: home.environmentId,
    build,
    autoDeploy: detail.autoDeploy ?? true,
    // A throwaway host is never asked for: it names the SOURCE's machine, and
    // createApp would either refuse it or point this app at the old box.
    autoDomain:
      mayClaimHosts && primary && !primary.generated ? primary.host : null,
    // Two apps of one team may share a hostname on different paths, and the
    // import is where that shape arrives - so the path is claimed with the name.
    autoDomainPath: primary?.pathPrefix || null,
    // A service that answered on NOTHING over there gets nothing here.
    noAutoDomain: domains.value.length === 0,
    composeService: isCompose ? (primary?.service ?? null) : null,
    composePort: isCompose ? (primary?.port ?? null) : null,
    // `app_mounts` is materialised by the compose deploy and by nothing else, so a
    // single-image app's config files are written later instead.
    mounts:
      isCompose && mounts.value.files.length > 0 ? mounts.value.files : null,
    // The icon comes across with everything else.
    logo: mapLogo(detail.icon),
    deploy: false,
  });

  // What does not speak HTTP: the ports the source published, on the app itself
  // rather than as a line telling somebody to rewrite it as a compose stack.
  if (ports.length > 0) {
    if (!(await canExposePorts()))
      notes.push(
        `It published ${ports
          .map((p) => p.published)
          .join(
            ", ",
          )} on its host. You don't have permission to publish ports, so it came across without them - ask an instance admin, then add them under Settings -> Advanced.`,
      );
    else
      try {
        await setAppPorts(created.id, ports);
      } catch (e) {
        notes.push(
          `${ports.map((p) => `${p.published}:${p.target}`).join(", ")} could not be published here (${
            e instanceof Error ? e.message : "the port was refused"
          }). Set them under Settings -> Advanced.`,
        );
      }
  }

  // One name in two environments is the commonest shape there is, and not an accident to
  // be corrected: only the internal name, one per team, has to give way.
  await landSourceBackups(
    detail.backups,
    home.destinations,
    { kind: "app", id: created.id, name },
    notes,
  );

  if (namesake)
    notes.push(
      `This team already has an app called ${name}${
        namesake.environmentName
          ? ` in the ${namesake.environmentName} environment`
          : ""
      }. Both are kept; this one is /apps/${created.slug}.`,
    );

  // The links the references asked for. A value must never vanish because a link
  // could not be made, so a refusal writes the entry back instead.
  const linkRefused: { key: string; value: string }[] = [];
  for (const r of linkable) {
    try {
      await setSharedVarAppLink(
        home.shared.get(r.sharedKey)!.varId,
        created.id,
        true,
      );
    } catch {
      const back = dropped.get(r.key);
      if (back) linkRefused.push(back);
    }
  }
  if (linkRefused.length > 0) {
    // `setAppEnv` is a whole-set replace, so it takes the FULL set back.
    await setAppEnv(created.id, [...env, ...linkRefused], undefined, {
      overwriteSecrets: true,
    });
    notes.push(
      `${linkRefused
        .map((e) => e.key)
        .join(
          ", ",
        )} could not be linked to the shared variable, so ${linkRefused.length === 1 ? "it kept its" : "they kept their"} own copy of the value.`,
    );
  }

  await report.add({
    sourceKind: svc.kind,
    sourceId: svc.id,
    sourceName: name,
    outcome: "created",
    targetKind: "app",
    targetId: created.id,
    message: `${env.length} variable(s), ${
      linkable.length - linkRefused.length
    } shared variable(s), ${mounts.value.files.length} config file(s).`,
  });
  const target = { kind: "app", id: created.id };

  await rehostAppDomains(created, domains, primary, env, notes);

  await landAppStorage(
    created,
    mounts,
    { isCompose, compose, asRepoApp, yamlText },
    notes,
  );

  await landAppExtras(
    c,
    svc,
    detail,
    created,
    { isCompose, secretKeys, serviceRenames },
    notes,
  );

  await report.notes(svc.kind, name, notes, target, svc.id);
  return created.id;
}

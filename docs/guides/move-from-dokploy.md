# Move from Dokploy

**Beta.**

## What it is

A wizard that reads an existing Dokploy installation over its API and recreates
it here: projects, apps, domains, environment variables, volumes and databases,
with the data copied across.

**Settings -> Migrations**, which needs `create_projects`.

## How it works

Deplo does not scrape files or ask you for SSH. It talks to the source panel's
API for the configuration, and for the data it puts an agent on the source
machine.

That agent is installed in a fourth, deliberately minimal server role: a
**migration source**. It is out of every deploy picker and every build picker,
never a backup destination, never swept by cleanup, absent from monitoring and
from the fleet count, and granted to one team only. It is also the **only**
server Deplo will uninstall itself from when you are done.

Volumes are copied by the agent standing on the disk that holds them, relayed
through the control plane, because agents cannot dial each other.

## Run a migration

1. Open **Settings -> Migrations**, the **Migrate** tab.
2. **Install the agent** on the source machine. The wizard prints the command,
   and if you are not an instance admin it tells you to ask one. It waits, and
   shows **Waiting for the agent** until the machine calls home.
3. Enter the **Panel address** and the **API key** of the source installation.
4. Deplo scans and shows you the tree: every project, app and database it found.
5. Choose what comes over. Per item you can set:
   - whether to include it
   - **Expose publicly** and a **Host port**, where that applies
   - **Build only**
   - **Deplo host**, which server it lands on
6. The **People** step offers to create registration links for the users on the
   source, so you can hand them out.
7. Review. Everything lands in one team: the current one, or **Create a new
   team**.
8. Click **Move it over**. A live console shows the progress.
9. Read **View report** at the end. It is copyable, and it lists everything that
   did not come across cleanly.

## After it lands

Two clean-up actions, and they are different:

- **Remove what came over** deletes what the migration created here, if you want
  to start again.
- **Remove from Deplo** takes the migration source out of the fleet. Deplo
  uninstalls its own agent from that machine first, and warns you if the agent
  is still installed.

The **History** tab keeps every past run with its report, and **Use this
address** re-fills the connection details for another pass.

## What changes on the way across

- **Throwaway hostnames get re-hosted.** A source app served on a generated
  `*.sslip.io`, `*.traefik.me` or `*.nip.io` name has the **old server's IP**
  baked into it, so that name would keep pointing at the old machine. Deplo
  mints its own equivalent, keeps the same route, and the app's **Domains**
  section tells you which address became which. Real domains you own come across
  as they are, and you repoint DNS when you are ready.
- **Imported basic-auth credentials are flagged.** They never went through
  Deplo's password policy or the breach check.
- **Anything needing a permission you do not hold lands in the report instead.**
  Authored Compose is treated as hostile here exactly as it is everywhere else:
  host bind mounts, `privileged`, published ports and foreign networks or
  volumes each need their grant.
- **An app still being created refuses every action** and draws as pending until
  its run finishes.

## Limits and gotchas

- **Cut DNS over yourself, when you are ready.** The migration does not touch
  your registrar.
- **Copying data takes as long as the data is big.** Volumes stream host to host
  through the control plane.
- **Run it twice and you get it twice.** There is no reconciliation: this is a
  move, not a sync.
- **Check the report, always.** A migration that says "done" with twelve lines
  in the report has twelve things waiting for you.
- **Uninstall the migration source afterwards.** It is a live agent on a machine
  you are about to decommission.

## If it does not work

- **The scan finds nothing** - wrong panel address, or the API key lacks
  access. Dokploy keys are scoped per organisation.
- **Stuck on Waiting for the agent** - the install command has not run on the
  source, or that machine cannot reach this one.
- **A volume arrives empty** - the report will say so. Re-run just that item
  rather than the whole migration.
- More in [Servers and agents](../troubleshooting/servers-and-agents.md).

## See also

- [Server roles](../advanced/server-roles.md)
- [Add a server](add-a-server.md)
- [Domains and HTTPS](domains-and-https.md)
- [`docs/adr/0025`](../adr/0025-a-migration-source-is-a-server-that-hosts-nothing.md)

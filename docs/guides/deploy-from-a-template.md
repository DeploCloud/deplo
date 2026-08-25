# Deploy from a template

## What it is

A one-click deploy of software somebody else already configured: WordPress,
Ghost, n8n, Plausible, Supabase, MinIO, Uptime Kuma, Postgres, Redis and a few
hundred more. You pick it, name it, choose a server, and it comes up with
sensible defaults and generated passwords.

## How it works

The catalogue is a **remote service**, not files in this repository, so a fresh
install has the whole catalogue with no configuration and new entries appear
without upgrading Deplo. Responses are cached for an hour, and searching filters
what is already loaded.

A **Template** is a family: the name, the logo, the screenshots, the category
and the long description. Each family holds one or more **variants**, and a
variant is what actually deploys: a `docker-compose.yml` plus a small manifest.
`garage-s3`, for example, ships a **Base** variant and a **Web UI** variant. A
family with one variant shows no chooser.

Deploying resolves the variant into a real Compose stack with your values filled
in, and creates an ordinary app from it. **Nothing about the template is stored
on the app afterwards.** It is yours from that moment: edit the Compose, change
the variables, add domains. The logo is copied into the app as inline data, so
your icons survive even if the catalogue is unreachable.

## Deploy one

1. Open **Templates** in the sidebar.
2. Find what you want. There is a search box, category chips, and curated
   collections: **Start here**, **Serving hot now**, **Run your own AI** and
   **Be your own bank**.
3. Open it. Read the description, pick a **Variant** if the family has several.
4. Click **Deploy**.
5. The wizard opens with everything filled in and locked to a summary. Set the
   app name, pick the server, and check the **Environment variables** card:
   passwords and keys are generated for you, and anything the template wants
   from you is listed there.
6. Click **Deploy**.

To change the stack before it ever runs, click **Edit template**. That unlocks
the full Compose editor and every field. **Reset to template** puts it back.

## After it is running

It is a normal app. Everything in these guides applies:

- Give it your own hostname in [Domains](domains-and-https.md).
- Its data is in [volumes](persistent-storage.md), which survive redeploys.
- Back it up like anything else: [Backups and restore](backups-and-restore.md).
- Read what it prints in [Logs](logs.md).

Most templates are multi-container Compose stacks, so a few things behave the
way [Compose apps](../advanced/compose-apps.md) describes: a domain names which
**Container** it routes to, and rollbacks are not available.

## Limits and gotchas

- **Templates are a starting point, not a subscription.** Updating the
  catalogue entry does not update apps you already created from it.
- **Read the variables before you deploy.** Some templates need a domain or an
  admin email set at first boot, and changing them afterwards means the software
  has already initialised itself with the old value.
- **A template can carry configuration files**, written next to the stack and
  mounted into the container. They show up under the app's storage.
- **Browsing is open to anybody; deploying needs `create_apps`.**
- **If the catalogue is unreachable**, the store shows an offline state. Apps
  you already deployed are unaffected.

## If it does not work

- **The store is empty or offline** - the instance cannot reach the catalogue
  service. Check outbound network access, or point
  `DEPLO_TEMPLATES_API_URL` at your own mirror.
- **The stack starts and one container keeps restarting** - almost always a
  required variable was left blank. Read that container's logs.
- **Two templates fight over a port** - only one thing can hold a host port. Use
  a domain instead of publishing a port.

## See also

- [Compose apps](../advanced/compose-apps.md)
- [Databases](databases.md) - for Postgres and friends, Deplo's own managed ones are usually a better fit
- [Environment variables](environment-variables.md)
- [`docs/adr/0023`](../adr/0023-the-template-catalog-is-a-remote-service.md)

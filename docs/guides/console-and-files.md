# Console and files

## What it is

Two escape hatches for when you need to look inside a running container: a real
terminal, and a file browser. Neither is on the first-run path, and neither is
required to use Deplo.

## How it works

Both go through the agent on the server, over the same mutual TLS connection
everything else uses. There is no SSH, no exposed Docker socket, and no port to
open.

The console is a real terminal, not a command box: it runs `docker exec` in a
container you pick, with a proper pseudo-terminal, so `top`, `vim` and an
interactive `psql` all behave. You can also **attach** to the main process's
live output instead.

The files browser is scoped to the app's own files directory. Symlinks are
resolved and the agent re-checks the boundary itself, so a link pointing at `/`
does not become a way out.

## Open a console

The console is hidden until you acknowledge it once.

1. Open the app, then **Settings -> Advanced**.
2. Click **Open console**.
3. Read the warning and click **I understand, open the console**. From then on
   the sidebar shows a **Console** entry whenever a container is running.

Pick which container from the instance picker. It lists every container in the
stack with its image, its user, its working directory and whether it is exposed,
plus the shell that was actually probed: `/bin/sh`, `/bin/bash`, or "raw exec
(no shell)". An image with no shell says so rather than failing mysteriously.

A database's console is the engine's own client: `psql`, `mysql`, `redis-cli`.

## Browse files

The **Files** tab appears once the app has a files directory. Browse it, open a
file, edit it, create a **New file** or a **Folder**, **Upload**, rename and
delete.

It is a configuration editor, not a blob store: writes are capped at 1 MiB.

A **File** volume in [persistent storage](persistent-storage.md) is the same
directory seen from the other side. Editing it there and editing it here are the
same act.

## Limits and gotchas

- **Changes inside a container do not survive a redeploy.** The container is
  recreated from the image. Anything you fix in a console is gone on the next
  deploy unless it lives in a volume or in your repository.
- **`open_app_console` and `open_database_console` are separate, sensitive
  capabilities.** A console is arbitrary code as that container's user.
- **The console needs something running.** A stopped app has no container to
  enter.
- **Reading files and writing files are two capabilities**, `read_app_files` and
  `write_app_files`, so "look but do not touch" is expressible.
- **This is not a way onto the host.** You are inside a container. Reaching the
  server itself needs [host access](../advanced/host-access-and-privileges.md),
  which is a different grant entirely.

## If it does not work

- **No Console entry in the sidebar** - the one-time acknowledgement has not
  been given on this browser, or nothing is running, or you lack the capability.
- **"raw exec (no shell)"** - a distroless or scratch image. You can still run a
  binary that exists in it, but there is no shell to type into.
- **The Files tab is missing** - the app has no files directory yet. It appears
  once something creates one.
- **A write is rejected** - over 1 MiB, or outside the app's directory.

## See also

- [Persistent storage](persistent-storage.md)
- [Cron jobs](cron-jobs.md) - the scheduled version of the same exec
- [Logs](logs.md) - usually the answer, without a shell
- [Capabilities](../reference/capabilities.md)

import { runWithIdentity } from "../lib/auth/request-context";
import { detectRepoFramework } from "../lib/apps/framework-source";
import { frameworkById } from "../lib/apps/framework-catalog";

const input = JSON.parse(process.argv[2]);
const hints = await runWithIdentity(
  { userId: "usr_37dbc29c296a612f", teamId: "team_543580aaec0225e7" },
  () =>
    detectRepoFramework(
      {
        provider: "github",
        url: input.url,
        repo: input.repo,
        branch: input.branch,
        installationId: input.installationId,
      } as never,
      input.rootDirectory,
    ),
);
const def = frameworkById(hints.framework);
console.log(
  JSON.stringify({
    id: hints.framework,
    name: def?.name ?? null,
    defaultPort: def?.defaultPort ?? null,
    staticOutput: hints.staticOutput,
    startCommand: hints.startCommand,
    buildCommand: hints.buildCommand,
  }),
);
process.exit(0);

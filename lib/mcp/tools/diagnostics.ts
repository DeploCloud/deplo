import * as z from "zod";
import { tool, type McpToolDef } from "./tool-def";

export const DIAGNOSTICS: McpToolDef[] = [
  tool({
    name: "whoami",
    title: "Who am I",
    description:
      "Which Deplo team this call ran in (the default when no `team` is passed), and what this token is allowed to do. Run this first when something is refused.",
    group: "Diagnostics",
    requires: null,
    readOnly: true,
    idempotent: true,
    input: z.object({}),
    query: /* GraphQL */ `
      query McpWhoami {
        apiContext
        me {
          id
          username
          name
          isInstanceAdmin
        }
        viewerTeam {
          id
          name
          slug
        }
      }
    `,
  }),
  tool({
    name: "list_teams",
    title: "List teams",
    description:
      "Every team this connection can name, with whether it can act there. To work in one, pass its id or slug as the `team` argument of any other tool - that is the only way to change team.",
    group: "Diagnostics",
    requires: null,
    readOnly: true,
    idempotent: true,
    input: z.object({}),
    query: /* GraphQL */ `
      query McpListTeams {
        mcpTeams {
          id
          name
          slug
          mcpEnabled
          canConnect
        }
      }
    `,
  }),
];

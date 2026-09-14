import "server-only";

import {
  execute,
  Kind,
  parse,
  specifiedRules,
  TypeInfo,
  validate,
  visit,
  visitWithTypeInfo,
  type DocumentNode,
} from "graphql";
import { maxDepthRule } from "@escape.tech/graphql-armor-max-depth";
import { maxAliasesRule } from "@escape.tech/graphql-armor-max-aliases";
import { costLimitRule } from "@escape.tech/graphql-armor-cost-limit";
import { schema } from "../graphql/schema";
import { safeMessage } from "../graphql/mask-error";
import { runWithIdentity } from "../auth/request-context";
import type { GraphQLContext } from "../graphql/context";

// Documents run IN-PROCESS against the schema `/api/graphql` serves: there is no second authorization path here.

const parsed = new Map<string, DocumentNode>();

function documentFor(query: string): DocumentNode {
  let doc = parsed.get(query);
  if (!doc) {
    doc = parse(query);
    parsed.set(query, doc);
  }
  return doc;
}

export interface ToolExecution {
  data: unknown;
  error?: string;
}

// runGraphql executes a document as the principal in `ctx`, answering an error rather than throwing.
export async function runGraphql(
  query: string | DocumentNode,
  variables: Record<string, unknown>,
  ctx: GraphQLContext,
): Promise<ToolExecution> {
  // A caller-written document arrives already parsed, so the memo never grows a key per agent-sent string.
  const document = typeof query === "string" ? documentFor(query) : query;
  const run = () =>
    execute({
      schema,
      document,
      variableValues: variables,
      contextValue: ctx,
    });
  // A null identity must mean "resolve nothing", never "run unattributed"; `runWithIdentity` has no null form.
  const value = await (ctx.identity
    ? runWithIdentity(ctx.identity, run)
    : run());
  // The same mask /api/graphql applies: a raw driver error carries the SQL and its bound values.
  const first = value.errors?.[0];
  const error = first ? safeMessage(first) : undefined;
  return { data: value.data ?? null, error };
}

// Root fields the passthrough never runs, whatever the token holds: each hands back a credential or runs code (ADR-0021 rule 4).
// The `reveal*` family is derived from the schema instead; these follow no naming rule.
const IRREGULAR = [
  "execConsole",
  "execDatabaseConsole",
  "rotateDatabasePassword",
  "rotateAppDeployHook",
  "destinationRecoveryKey",
  "createToken",
  "updateToken",
  "mintRegistrationLink",
  // Mints an install command carrying a server's agent enrolment token.
  "reissueServerBootstrap",
  "regenerateRecoveryCodes",
  "startTwoFactorEnrolment",
  "startPasskeyRegistration",
  "passkeyChallenge",
  // These set a session cookie, and in-process there is no response to set it on.
  "login",
  "verifyPasskeyLogin",
  "verifyTwoFactorLogin",
];

let denied: Set<string> | undefined;

export function deniedRootFields(): Set<string> {
  denied ??= new Set(
    [
      ...Object.keys(schema.getQueryType()!.getFields()),
      ...Object.keys(schema.getMutationType()!.getFields()),
    ]
      .filter((name) => /^reveal[A-Z]/.test(name))
      .concat(IRREGULAR),
  );
  return denied;
}

// The same limits `/api/graphql` puts on an external client (lib/graphql/yoga.ts).
const PASSTHROUGH_RULES = [
  ...specifiedRules,
  maxDepthRule({ n: 12 }),
  maxAliasesRule({ n: 30 }),
  costLimitRule({ maxCost: 5000 }),
];

// admitPassthrough vets a caller-written document, throwing a sentence the tool handler turns into an `isError`.
export function admitPassthrough(
  query: string,
  kind: "query" | "mutation",
): DocumentNode {
  const doc = parse(query);

  const ops = doc.definitions.filter(
    (d) => d.kind === Kind.OPERATION_DEFINITION,
  );
  if (ops.length === 0)
    throw new Error("That document has no query or mutation in it.");
  // Every operation, not just the first: a second one would otherwise run whatever it liked.
  for (const op of ops)
    if (op.operation !== kind)
      throw new Error(
        op.operation === "subscription"
          ? "Subscriptions cannot be run over MCP. Poll the matching read instead."
          : `graphql_${kind === "query" ? "query" : "mutate"} runs ${kind} operations only, and this document is a ${op.operation}. Use graphql_${op.operation === "mutation" ? "mutate" : "query"}.`,
      );

  // Before validation on purpose, so a denied field hears why; judged on the PARENT TYPE, so a `login` field on some object stays readable.
  const blocked = deniedRootFields();
  const typeInfo = new TypeInfo(schema);
  visit(
    doc,
    visitWithTypeInfo(typeInfo, {
      Field(node) {
        const parent = typeInfo.getParentType();
        if (
          (parent === schema.getQueryType() ||
            parent === schema.getMutationType()) &&
          blocked.has(node.name.value)
        )
          throw new Error(
            `"${node.name.value}" cannot be run over MCP. It returns a credential or runs a command, and a secret that reaches a model's context has left Deplo for good. Use the Deplo dashboard for this one.`,
          );
      },
    }),
  );

  const errors = validate(schema, doc, PASSTHROUGH_RULES);
  if (errors.length) throw new Error(errors[0].message);

  return doc;
}

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
import { runWithIdentity } from "../auth/request-context";
import type { GraphQLContext } from "../graphql/context";

/**
 * Runs one MCP tool by executing its GraphQL document IN-PROCESS against the very
 * schema `/api/graphql` serves. There is no second authorization path here, and
 * there must never be one.
 */

/** Documents are parsed once at first use, not per call. */
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
  /** The first GraphQL error's message, surfaced verbatim, never rewritten. */
  error?: string;
}

/**
 * Execute `query` with `variables` as the principal in `ctx`. A thrown error would
 * become an opaque protocol failure instead.
 */
export async function runGraphql(
  query: string | DocumentNode,
  variables: Record<string, unknown>,
  ctx: GraphQLContext,
): Promise<ToolExecution> {
  // A caller-written document is passed through already parsed: the memo above is
  // a memo of the 70-odd constants, not an unbounded map keyed on whatever an
  // agent sent.
  const document = typeof query === "string" ? documentFor(query) : query;
  const run = () =>
    execute({
      schema,
      document,
      variableValues: variables,
      contextValue: ctx,
    });
  // The route only ever builds a token principal, so `identity` is always set; the
  // guard is here because a null one must mean "resolve nothing" rather than "run
  // unattributed" - `runWithIdentity` has no null form, and the data layer's own
  const value = await (ctx.identity
    ? runWithIdentity(ctx.identity, run)
    : run());
  const error = value.errors?.[0]?.message;
  return { data: value.data ?? null, error };
}

/* ------------------------------------------------------------------ *
 * The escape hatch's door
 * ------------------------------------------------------------------ */

/**
 * Root fields the passthrough never runs, whatever the token holds. Every one
 * either hands back a credential or executes code (ADR-0021 rule 4, which is
 * otherwise only a regex over the tool table and so misses a written document).
 * The `reveal*` family is derived from the schema instead of listed, so a new
 * one is refused the day it lands; these are the ones that follow no naming rule.
 */
const IRREGULAR = [
  "execConsole",
  "execDatabaseConsole",
  "rotateDatabasePassword",
  "rotateAppDeployHook",
  "destinationRecoveryKey",
  "createToken",
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

/** The same limits `/api/graphql` puts on an external client (lib/graphql/yoga.ts). */
const PASSTHROUGH_RULES = [
  ...specifiedRules,
  maxDepthRule({ n: 12 }),
  maxAliasesRule({ n: 30 }),
  costLimitRule({ maxCost: 5000 }),
];

/**
 * Parse and vet a document the caller wrote. Throws a sentence the model can act
 * on; the tool handler turns it into an `isError` result.
 */
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
  // Every operation, not just the first: pinning only one leaves a second to run
  // whatever it likes, and a subscription would execute here with no transport.
  for (const op of ops)
    if (op.operation !== kind)
      throw new Error(
        op.operation === "subscription"
          ? "Subscriptions cannot be run over MCP. Poll the matching read instead."
          : `graphql_${kind === "query" ? "query" : "mutate"} runs ${kind} operations only, and this document is a ${op.operation}. Use graphql_${op.operation === "mutation" ? "mutate" : "query"}.`,
      );

  // Before validation on purpose: a denied field must hear why it is denied,
  // not a complaint about a selection set it also got wrong. Judged on the
  // PARENT TYPE, not the name, so a field called `login` on some object stays
  // readable.
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

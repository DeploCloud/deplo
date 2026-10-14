import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  visit,
  Scalar,
} from "../yaml";

export const MASKED = "••••••••";
const WITHHELD = "# Hidden: this compose file could not be read.\n";

// "all" masks every value below, "entries" keeps the KEY of KEY=value / KEY: value, "labels" also keeps routing labels.
type Rule = "all" | "entries" | "labels" | { [key: string]: Rule };
const HOOK: Rule = { command: "all", environment: "entries" };
const SERVICE: Rule = {
  environment: "entries",
  labels: "labels",
  annotations: "entries",
  command: "all",
  entrypoint: "all",
  build: { args: "entries", labels: "labels" },
  healthcheck: { test: "all" },
  logging: { options: "entries" },
  deploy: { labels: "labels" },
  post_start: HOOK,
  pre_stop: HOOK,
};
const RESOURCE: Rule = {
  driver_opts: "entries",
  labels: "labels",
  content: "all",
};
const NAMED: Record<string, Rule> = {
  services: SERVICE,
  volumes: RESOURCE,
  networks: RESOURCE,
  secrets: RESOURCE,
  configs: RESOURCE,
};
// The routing Deplo renders itself; any other label value may hold a credential.
const VISIBLE_LABEL =
  /^(deplo\.[\w.-]+|traefik\.(enable|docker\.network|http\.routers\.[\w-]+\.(rule|entrypoints|service|middlewares|priority|tls|tls\.certresolver)|http\.services\.[\w-]+\.loadbalancer\.server\.port|http\.middlewares\.[\w-]+\.(stripprefix\.prefixes|redirectregex\.(regex|replacement|permanent)|headers\.(contenttypenosniff|customframeoptionsvalue|referrerpolicy|accesscontrol\w+|addvaryheader))))$/i;
const URL_PASSWORD = /(\b[a-z][\w+.-]*:\/\/[^\s/:@]*:)[^\s/@]+@/gi;

// Served below configure_apps: every value that may be a secret is masked on the parsed YAML, anchors followed.
export function redactComposeForDisplay(yaml: string): string {
  const doc = parseDocument(yaml);
  if (doc.errors.length) return WITHHELD;
  let changed = false;
  const done = new Set<unknown>();
  const deref = (n: unknown): unknown => (isAlias(n) ? n.resolve(doc) : n);
  const keyOf = (key: unknown): string =>
    isScalar(key) ? String(key.value).trim() : "";
  const set = (s: Scalar, value: string): void => {
    if (s.type === Scalar.BLOCK_LITERAL || s.type === Scalar.BLOCK_FOLDED)
      s.type = Scalar.QUOTE_DOUBLE;
    s.value = value;
    s.tag = undefined;
    changed = true;
  };

  const maskAll = (node: unknown): void => {
    const n = deref(node);
    if (!n || done.has(n)) return;
    done.add(n);
    if (isScalar(n)) {
      if (n.value == null) return;
      set(n, MASKED);
      n.type = Scalar.QUOTE_DOUBLE;
    } else if (isMap(n)) n.items.forEach((p) => maskAll(p.value));
    else if (isSeq(n)) n.items.forEach(maskAll);
  };

  const maskEntries = (node: unknown, labels: boolean): void => {
    const n = deref(node);
    const shown = (key: string) => labels && VISIBLE_LABEL.test(key.trim());
    if (!n || done.has(n)) return;
    if (isMap(n)) {
      done.add(n);
      for (const p of n.items) {
        // A `<<` merge key: mask the merged map's values, keep its keys.
        if (isScalar(p.key) && typeof p.key.value === "symbol") {
          const from = deref(p.value);
          for (const m of isSeq(from) ? from.items : [from])
            maskEntries(m, labels);
        } else if (!shown(keyOf(p.key))) maskAll(p.value);
      }
    } else if (isSeq(n)) {
      done.add(n);
      for (const item of n.items) {
        const s = deref(item);
        if (!isScalar(s) || typeof s.value !== "string") maskAll(s);
        else if (!done.has(s)) {
          const at = s.value.indexOf("=");
          if (at < 0 || shown(s.value.slice(0, at))) continue;
          done.add(s);
          set(s, `${s.value.slice(0, at + 1)}${MASKED}`);
        }
      }
    } else maskAll(n);
  };

  const apply = (node: unknown, rule: Rule): void => {
    const n = deref(node);
    if (rule === "all") return maskAll(n);
    if (rule === "entries" || rule === "labels")
      return maskEntries(n, rule === "labels");
    if (isSeq(n)) return n.items.forEach((i) => apply(i, rule));
    if (!isMap(n)) return;
    for (const p of n.items) {
      const key = keyOf(p.key);
      if (key.startsWith("x-")) maskAll(p.value);
      else if (Object.hasOwn(rule, key)) apply(p.value, rule[key]);
    }
  };

  const top = deref(doc.contents);
  if (isMap(top))
    for (const p of top.items) {
      const key = keyOf(p.key);
      const entries = deref(p.value);
      if (key.startsWith("x-")) maskAll(p.value);
      else if (Object.hasOwn(NAMED, key) && isMap(entries))
        for (const e of entries.items) apply(e.value, NAMED[key]);
    }

  // Comments can hold a commented-out value, and a URL anywhere can carry a password.
  if (doc.comment || doc.commentBefore) changed = true;
  doc.comment = doc.commentBefore = null;
  visit(doc, {
    Node(_k, n) {
      if (n.comment || n.commentBefore) changed = true;
      n.comment = n.commentBefore = undefined;
      if (isScalar(n) && typeof n.value === "string") {
        const value = n.value.replace(URL_PASSWORD, `$1${MASKED}@`);
        if (value !== n.value) set(n, value);
      }
    },
  });
  if (!changed) return yaml;
  return doc.contents == null ? "" : doc.toString({ lineWidth: 0 });
}

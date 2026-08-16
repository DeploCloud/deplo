/**
 * What a rendered stack may say to someone who only holds `view`.
 *
 * "View full compose" is served at the `view` floor - an app's own YAML is not a
 * secret and seeing it is half of understanding a deploy. What IS a secret is
 * everything the render resolves INTO that YAML, and there are exactly two
 * kinds:
 *
 *  - **env values.** A single-image stack inlines the resolved plaintext (the
 *    app's vars, its linked shared vars, the instance globals). Names stay, so
 *    the preview still shows what the deploy injects; values go.
 *  - **the basic-auth htpasswd line**, which rides a Traefik LABEL and so sits
 *    nowhere near `environment:`. It was therefore readable by any member of the
 *    team while managing those credentials takes `manage_basic_auth`, and a
 *    bcrypt hash at cost 10 is an offline guess away from the plaintext.
 *
 * Pure and dependency-free so both can be tested directly: this is the only
 * thing standing between a rendered stack and a client, and a redaction nobody
 * can exercise is a redaction nobody notices losing.
 */

export const MASKED = "••••••••";

/**
 * Hide the htpasswd line inside a Traefik `basicauth.users` label, wherever in
 * the file it sits. Returns null when the line carries no such label.
 *
 * The username half goes too. Splitting the line to keep it would be a second
 * parser over a value the operator can put anything in, and Settings → Access is
 * where those names belong.
 */
export function maskBasicAuthLabel(line: string): string | null {
  const KEY = "basicauth.users";
  const at = line.indexOf(KEY);
  if (at < 0) return null;
  // `...users=<htpasswd>` (list form) or `...users: <htpasswd>` (map form).
  const sep = /^\s*[=:]\s*/.exec(line.slice(at + KEY.length));
  if (!sep) return null;
  return `${line.slice(0, at)}${KEY}${sep[0]}${MASKED}`;
}

/**
 * Redact a rendered stack for display: every value under an `environment:`
 * block, plus the basic-auth label ({@link maskBasicAuthLabel}).
 *
 * Compose stacks already carry env NAMES only (bare `- KEY` pass-throughs; the
 * values ride the env-file), so their lines pass through unchanged.
 */
export function redactComposeForDisplay(yaml: string): string {
  let envIndent: number | null = null;
  return yaml
    .split("\n")
    .map((line) => {
      // Asked FIRST and outside the environment tracking: the label lives under
      // `labels:`, which the block walk below never enters.
      const basicAuth = maskBasicAuthLabel(line);
      if (basicAuth !== null) return basicAuth;
      const trimmed = line.trim();
      const indent = line.length - line.trimStart().length;
      if (envIndent !== null) {
        if (trimmed !== "" && indent <= envIndent) {
          envIndent = null; // left the environment: block
        } else if (trimmed !== "") {
          // Map form (`KEY: value`) and list form (`- KEY=value`) both hide
          // the value; a bare `- KEY` pass-through has none to hide.
          const map = /^(\s+[^\s:]+:)\s+\S.*$/.exec(line);
          if (map) return `${map[1]} ${JSON.stringify(MASKED)}`;
          const list = /^(\s+-\s+)(["']?)([^=\s"']+)=.*$/.exec(line);
          if (list) return `${list[1]}${list[3]}=${MASKED}`;
          return line;
        }
      }
      if (envIndent === null && trimmed === "environment:") envIndent = indent;
      return line;
    })
    .join("\n");
}

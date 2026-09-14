import type { CoolifyApplication } from "../client";

/** Bytes no `key=value` line can hold: C0 controls other than tab/newline, and
 *  the replacement character a mis-decode leaves behind. */
const NOT_TEXT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]/;

/**
 * `custom_labels` is base64 with one `key=value` per line - EXCEPT that Coolify
 * hands it back in clear for anything it never deployed. `Buffer.from` does not
 * throw on that, it answers mojibake, so what decodes has to be TEXT.
 */
function decodeLabels(raw: string | null | undefined): string[] {
  const text = raw?.trim();
  if (!text) return [];
  const decoded = Buffer.from(text, "base64").toString("utf8");
  const usable = decoded.trim() !== "" && !NOT_TEXT.test(decoded);
  return (usable ? decoded : text)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Everything Coolify carries that Deplo has nowhere to put. Each one is a line in
 * the report rather than a silent loss.
 */
export function coolifyNotes(row: CoolifyApplication): string[] {
  const notes: string[] = [];

  // The proxy labels {panel} generates itself are dropped: Deplo owns that grammar
  // and writes its own. `http-basic-auth-<uuid>` is its rendering of the basic auth
  // the import already carries through its own columns.
  const generated = new RegExp(
    `^(traefik\\.enable=|traefik\\.http\\.(routers|services)\\.${row.uuid}|traefik\\.http\\.routers\\.https-|traefik\\.http\\.routers\\.http-|traefik\\.http\\.services\\.https-|traefik\\.http\\.services\\.http-|traefik\\.http\\.middlewares\\.(gzip|redirect-to-https|redirect-to-http|http-basic-auth-)|caddy_)`,
    "i",
  );
  const labels = decodeLabels(row.custom_labels)
    .filter((l) => !generated.test(l))
    // A credential never rides in a report line, whoever wrote the middleware.
    .map((l) =>
      /\.(basicauth|digestauth)\.users(file)?=/i.test(l)
        ? l.replace(/=.*$/, "=<credentials>")
        : l,
    );
  if (labels.length > 0)
    notes.push(
      `Custom container label(s) on {panel} that Deplo does not carry: ${labels.join(", ")}.`,
    );

  if (row.custom_docker_run_options?.trim())
    notes.push(
      `Custom docker run options on {panel} ("${row.custom_docker_run_options.trim()}") are not applied here - set what you need under Advanced.`,
    );

  if (row.custom_network_aliases?.trim())
    notes.push(
      `Network aliases on {panel} ("${row.custom_network_aliases.trim()}") are dropped - Deplo names every service on its shared network itself.`,
    );

  for (const [value, container, when] of [
    [
      row.pre_deployment_command,
      row.pre_deployment_command_container,
      "before",
    ],
    [
      row.post_deployment_command,
      row.post_deployment_command_container,
      "after",
    ],
  ] as const)
    if (value?.trim())
      notes.push(
        `A command ran ${when} every deploy on {panel}${container?.trim() ? ` in ${container.trim()}` : ""}: "${value.trim()}". Deplo has no deployment hook - run it from the console or as a cron job.`,
      );

  if (row.redirect === "www" || row.redirect === "non-www")
    notes.push(
      `{panel} redirected ${row.redirect === "www" ? "the bare domain to www" : "www to the bare domain"}. Add the other hostname under Domains and point it at this one.`,
    );

  if (row.limits_cpuset?.trim())
    notes.push(
      `Pinned to CPUs ${row.limits_cpuset.trim()} on {panel} - set it under Resources if it still matters.`,
    );
  if (row.limits_memory_swap?.trim() && row.limits_memory_swap.trim() !== "0")
    notes.push(
      `A memory swap limit of ${row.limits_memory_swap.trim()} on {panel} - set it under Resources if it still matters.`,
    );

  if (
    row.build_pack === "static" &&
    row.custom_nginx_configuration?.trim() !== undefined &&
    row.custom_nginx_configuration?.trim()
  )
    notes.push(
      "A custom web-server configuration on {panel} is not imported - Deplo owns the static server's config.",
    );

  if (row.build_pack === "dockerfile" && !row.git_repository?.trim())
    notes.push(
      "Its Dockerfile was typed into {panel} with no repository behind it - paste it into a file here and build from it.",
    );

  if (row.health_check_enabled) {
    const extra: string[] = [];
    if (row.health_check_method && row.health_check_method !== "GET")
      extra.push(`method ${row.health_check_method}`);
    if (row.health_check_scheme && row.health_check_scheme !== "http")
      extra.push(`scheme ${row.health_check_scheme}`);
    if (row.health_check_host && row.health_check_host !== "localhost")
      extra.push(`host ${row.health_check_host}`);
    if (row.health_check_return_code && row.health_check_return_code !== 200)
      extra.push(`expected code ${row.health_check_return_code}`);
    if (row.health_check_response_text?.trim())
      extra.push(`expected text "${row.health_check_response_text.trim()}"`);
    if (extra.length > 0)
      notes.push(
        `Its health check on {panel} also checked ${extra.join(", ")}, which Deplo's does not.`,
      );
  }

  return notes;
}

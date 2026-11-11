/**
 * Stands in for the registries of the images named, as `<repository>:<tag>` to the architectures each lists.
 * Any other request goes to the `fetch` that was there; the caller puts that one back.
 */
export function fakeRegistry(images: Record<string, string[]>): string[] {
  const asked: string[] = [];
  const rest = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === "/v2/") return new Response("{}");
    const m = /^\/v2\/(.+)\/manifests\/(.+)$/.exec(path);
    if (!m) return rest(url, init);
    const image = `${m[1]}:${decodeURIComponent(m[2]!)}`;
    asked.push(image);
    const archs = images[image];
    if (!archs) return new Response(null, { status: 404 });
    return new Response(
      JSON.stringify({
        manifests: archs.map((architecture) => ({
          digest: `sha256:${architecture}`,
          platform: { os: "linux", architecture },
        })),
      }),
    );
  }) as typeof fetch;
  return asked;
}

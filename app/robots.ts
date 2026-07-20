import type { MetadataRoute } from "next";

/**
 * The deplo control plane is a private operations panel: every page sits behind
 * auth and there is nothing here a search engine should ever surface. Tell all
 * crawlers to stay out of the whole origin.
 *
 * This robots.txt is only the polite signal. The enforcement that also holds
 * against non-compliant bots lives in the `X-Robots-Tag: noindex` response
 * header (next.config.ts + proxy.ts) and the `robots` metadata in app/layout.tsx.
 * No sitemap is emitted — there is deliberately nothing to advertise.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      disallow: "/",
    },
  };
}

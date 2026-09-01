import type { MetadataRoute } from "next";

/**
 * The Deplo control plane is a private operations panel: every page sits behind
 * auth and there is nothing here a search engine should ever surface.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      disallow: "/",
    },
  };
}

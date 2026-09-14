import type { MetadataRoute } from "next";

// robots - the control plane is a private panel behind auth; nothing here is ever indexed.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      disallow: "/",
    },
  };
}

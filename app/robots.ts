// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import type { MetadataRoute } from "next";

/**
 * The deplo control plane is a private operations panel: every page sits behind
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

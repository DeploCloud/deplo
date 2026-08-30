// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Next.js instrumentation hook. An early `return` on the same condition would work
 * at runtime but still compile the Node code into the Edge bundle, which is what
 * made the build warn about `process.once`.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { register: registerNode } = await import("./instrumentation-node");
    await registerNode();
  }
}

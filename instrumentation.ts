/**
 * Next.js instrumentation hook. Next calls `register` in EVERY runtime, and the
 * whole boot sequence (migrations, reconciles, schedulers, the SIGTERM/SIGINT
 * teardown) is Node-only — it uses `server-only` modules and `process.once`,
 * which the Edge runtime doesn't have.
 *
 * So the real work lives in ./instrumentation-node.ts and is reached through the
 * literal `NEXT_RUNTIME === "nodejs"` check below, the shape the bundler
 * dead-code-eliminates (see node_modules/next/dist/docs/.../instrumentation.md,
 * "Importing runtime-specific code"). An early `return` on the same condition
 * would work at runtime but still compile the Node code into the Edge bundle,
 * which is what made the build warn about `process.once`.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { register: registerNode } = await import("./instrumentation-node");
    await registerNode();
  }
}

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { register: registerNode } =
      await import("./lib/instrumentation/node");
    await registerNode();
  }
}

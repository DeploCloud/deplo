// register - the Node half stays a dynamic import so it never compiles into the Edge bundle.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { register: registerNode } = await import("./instrumentation-node");
    await registerNode();
  }
}

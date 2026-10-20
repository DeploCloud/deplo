# ADR-0037: A panel pins its agent

**Status**: accepted

Every Deplo version names exactly one `deplo-agent` release and the oldest one it still talks to, in `package.json`: `"deplo": { "agent": "…", "agentMin": "…" }`. This replaces the always-latest policy, where the expected agent was whatever GitHub called newest and the canary switch moved agents as well as the panel.

**The canary switch decides the panel; the panel decides the agent.** An agent canary reaches a server only inside a panel canary that pins it. `install-agent.sh` and the self-update both install the pin, resolved from the tag's `checksums.txt` on `github.com`, never the API. CI refuses to publish a panel image whose pin has no published release.

**Never downgrade.** An agent newer than the pin is compatible and left alone. An agent older than `agentMin`, or one whose version does not parse, is **unusable**: `connectAgent` refuses every call with one message until it updates. Hello, SelfUpdate, certificate renewal and the Deplo self-update stay open, so the way out is never blocked. A refusal always rests on a live Hello, never on the stored `agent_version` (CONTEXT.md: a stored value is never a gate). Running containers are not touched.

**Deplo does the update, a person only retries it.** Every provisioned server behind the pin is updated automatically, one at a time, remotes with the fewest Apps first and the Deplo host last. A failed attempt retries with backoff (1, 2, 4 … 60 minutes) for 24 hours from the first failure. Only after a failure may an instance admin press Retry now, which runs at once, cancels the scheduled retry and keeps the 24-hour window. One attempt per server at a time, claimed atomically in `server_agent_updates`. A server that took a new agent and never came back pauses the rest of the fleet until it recovers. A server that was unreachable when Deplo gave up gets exactly one more attempt when it is next seen.

**Warn before and after.** Before a panel update, the Updates tab names offline servers below the new release's `agentMin` (read from that tag's `package.json`). After it, an admin banner, an Activity entry and the `agent_incompatible` alert say which servers are unusable. `deplo update` on the host follows the panel's canary switch and never resolves a version older than the one installed.

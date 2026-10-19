# ADR-0036: Custom Traefik labels

**Status**: accepted

The control plane merges authorized custom labels after generated routing. The agent still rejects every image carrying `traefik.*`, including unreadable image metadata.

`Configure Traefik` is an instance-wide user grant. Only an instance admin can assign it; team roles cannot grant it. Saving also requires the app's normal configuration permission. Custom labels can affect the shared proxy, including other teams' routes.

Compose stores labels in the authored service. Other apps use the Advanced settings editor and normalized `app_traefik_labels` rows. Saving records the author in `apps.traefik_labels_by`. Deploy and reroute recheck that author's current grant and suspension state. Revocation blocks subsequent application; it does not rewrite running containers.

Exact keys override generated values, with case-insensitive matching. Complete custom router/backend definitions replace generated routers and services for that container. Partial overrides retain automatic defaults. Custom middleware attaches to generated HTTP routes unless an explicit middleware list overrides it. Tracking labels remain controlled by Deplo.

Existing Compose configurations keep their previous behavior until an authorized user saves them. Preview deployments keep automatic routing and never inherit full custom overrides. Image labels never receive this authorization.

Values must be literal Compose values, with `$$` for a dollar sign, so changing an environment variable cannot change the approved proxy configuration. Limits are 256 labels and 64 KiB per service. Static entrypoints, certificate resolvers and plugins must already exist in Traefik.

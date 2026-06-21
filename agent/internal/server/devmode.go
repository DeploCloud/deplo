package server

import (
	"archive/tar"
	"bytes"
	"context"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "github.com/idradev/deplo/agent/gen"
	"github.com/idradev/deplo/agent/internal/dockercli"
	"github.com/idradev/deplo/agent/internal/safepath"
)

// devmode.go ports lib/deploy/dev.ts to the agent (PLAN Part D): the per-host dev
// container lifecycle. Dev containers are per-host singletons (ADR-0002); once a
// project lives on a remote server its dev container runs THERE. The control
// plane stays the source of truth — it renders the dev compose (renderDevCompose),
// the entrypoint script, the tokenized clone URL, and (for upload) the archive,
// all opaque to the agent (D2). The agent writes files + drives Docker, exactly
// as lib/deploy/dev.ts did against the local socket.

// WORKSPACE_BUILD_EXCLUDE — the workspace entries that are NOT the developer's
// source and must never enter a production build context: the deps-volume
// mountpoint, the tunnel/CLI state, the fallback HOME, and git metadata. MUST
// match WORKSPACE_BUILD_EXCLUDE in lib/deploy/dev.ts (a deploy and the
// source-existence check can never disagree on what counts as source).
var workspaceBuildExclude = map[string]struct{}{
	"node_modules": {},
	".deplo":       {},
	".deplo-home":  {},
	".git":         {},
}

// devDir is the host dir holding all persistent dev workspaces (one per
// dev-enabled project) — mirrors lib/deploy/dev.ts DEV_DIR (<DATA_DIR>/dev).
func (s *Service) devDir() string { return filepath.Join(s.dataBase, "dev") }

// workspaceDir is a project's persistent workspace (the /workspace bind source).
func (s *Service) workspaceDir(slug string) string {
	return filepath.Join(s.devDir(), slug)
}

// devEntryPath is where the bind-mounted dev entrypoint script lives (shipped
// once per start; the rendered dev compose bind-mounts it read-only).
func (s *Service) devEntryPath() string {
	return filepath.Join(s.devDir(), "_entry", "deplo-dev-entry")
}

// cloneSecretPath is the root-owned 0600 file the tokenized clone URL is staged
// to (the dev compose bind-mounts it at /run/deplo/clone-url; the dev user can't
// read it and it never appears in env / docker inspect).
func (s *Service) cloneSecretPath(slug string) string {
	return filepath.Join(s.devDir(), "_secrets", slug+".url")
}

func (s *Service) devStackFile(slug string) string {
	return filepath.Join(s.stackDir, "dev-"+slug+".yml")
}

func devProjectName(slug string) string { return "deplo-dev-" + slug }
func depsVolume(slug string) string     { return "deplo-dev-" + slug + "-deps" }

// StartDev starts (or restarts) a project's dev container, streaming progress.
// Mirrors lib/deploy/dev.ts startDev: ensure the entry script + workspace dir
// (chowned 1000), stage the clone secret / seed an upload workspace, write the
// rendered stack, `compose up -d`. Server-streaming (like Deploy) so the
// materialise/up logs flow into the same SSE plumbing; emits a terminal result.
func (s *Service) StartDev(req *pb.StartDevRequest, stream pb.Agent_StartDevServer) error {
	e := &emitter{send: stream.Send}
	s.startDevBody(stream.Context(), req, e)
	return nil
}

// ResetDevWorkspace is DESTRUCTIVE: stop the container, wipe the workspace + deps
// volume, then reseed via the StartDev body (the same payload reseeds). Mirrors
// lib/deploy/dev.ts resetDevWorkspace.
func (s *Service) ResetDevWorkspace(req *pb.StartDevRequest, stream pb.Agent_ResetDevWorkspaceServer) error {
	e := &emitter{send: stream.Send}
	ctx := stream.Context()
	slug := req.GetSlug()
	if slug == "" {
		e.result(false, "dev request missing slug", "")
		return nil
	}
	e.phase(pb.DeployPhase_DEPLOY_PHASE_PREPARING)
	e.log("info", "Resetting the dev workspace…")
	// 1. Stop so nothing holds the bind mount during the wipe.
	s.stopDevContainer(ctx, slug)
	// 2. Wipe the workspace contents (keep the dir — it's the bind target).
	ws := s.workspaceDir(slug)
	_ = os.RemoveAll(ws)
	if err := os.MkdirAll(ws, 0o755); err != nil {
		e.result(false, "recreate workspace: "+err.Error(), "")
		return nil
	}
	// 3. Drop the deps volume so dependencies reinstall for the new source.
	_, _ = dockercli.Run(ctx, 30*time.Second, "volume", "rm", "-f", depsVolume(slug))
	// 4. Reseed: the StartDev body re-stages a fresh clone token and the
	//    entrypoint clones/extracts the current source into the empty workspace.
	s.startDevBody(ctx, req, e)
	return nil
}

// startDevBody is the shared start/reseed body. It NEVER returns an error; it
// emits a terminal DeployResult (ready/error) so the control plane writes the
// dev status exactly as it does for a deploy.
func (s *Service) startDevBody(ctx context.Context, req *pb.StartDevRequest, e *emitter) {
	slug := req.GetSlug()
	if slug == "" {
		e.result(false, "dev request missing slug", "")
		return
	}
	if req.GetComposeYaml() == "" {
		e.result(false, "dev request missing rendered compose", "")
		return
	}

	e.phase(pb.DeployPhase_DEPLOY_PHASE_PREPARING)
	if err := os.MkdirAll(s.stackDir, 0o755); err != nil {
		e.result(false, "create stack dir: "+err.Error(), "")
		return
	}
	if err := dockercli.EnsureNetwork(ctx, "deplo"); err != nil {
		e.result(false, "ensure network: "+err.Error(), "")
		return
	}

	// Write the bind-mounted dev entrypoint (idempotent; overwrites on upgrade).
	if err := s.ensureDevEntry(req.GetEntryScript()); err != nil {
		e.result(false, "write dev entrypoint: "+err.Error(), "")
		return
	}

	ws := s.workspaceDir(slug)
	if err := os.MkdirAll(ws, 0o755); err != nil {
		e.result(false, "create workspace: "+err.Error(), "")
		return
	}
	// Pre-chown so the dev server (UID 1000) and the developer never fight over
	// ownership across the bind mount. The bind SOURCE is the HOST path (the
	// control plane host-translates it when it runs containerized; for a bare-host
	// remote agent it equals the plain workspace path). Best-effort — the
	// entrypoint re-chowns too.
	chownMount := req.GetWorkspaceHostPath()
	if chownMount == "" {
		chownMount = ws
	}
	_, _ = dockercli.Run(ctx, 30*time.Second, "run", "--rm", "-v", chownMount+":/workspace",
		"alpine", "chown", "1000:1000", "/workspace")

	// Stage the tokenized clone URL to a root-only 0600 file (never in env), or
	// clear a stale one when this is no longer a git source.
	if err := s.writeCloneSecret(slug, req.GetCloneSecretUrl()); err != nil {
		e.result(false, "stage clone secret: "+err.Error(), "")
		return
	}
	// For an upload source, extract the archive into the (empty) workspace
	// host-side before the container starts (the archive isn't mounted inside).
	if len(req.GetUploadTar()) > 0 {
		if err := s.seedUploadWorkspace(slug, req.GetUploadTar(), e); err != nil {
			e.result(false, "seed workspace: "+err.Error(), "")
			return
		}
	}

	// Write the rendered dev stack (0600: it holds decrypted `development` env).
	stackFile := s.devStackFile(slug)
	if err := os.WriteFile(stackFile, []byte(req.GetComposeYaml()), 0o600); err != nil {
		e.result(false, "write dev stack: "+err.Error(), "")
		return
	}

	e.phase(pb.DeployPhase_DEPLOY_PHASE_STARTING)
	e.log("command", "docker compose -p "+devProjectName(slug)+" up -d")
	code, err := dockercli.Stream(ctx, 10*time.Minute, func(l string) { e.log("info", l) }, "",
		"compose", "-p", devProjectName(slug), "-f", stackFile, "up", "-d", "--remove-orphans")
	if err != nil {
		e.result(false, "compose up: "+err.Error(), "")
		return
	}
	if code != 0 {
		e.result(false, fmt.Sprintf("docker compose up failed (exit %d)", code), "")
		return
	}

	e.phase(pb.DeployPhase_DEPLOY_PHASE_WAITING)
	if waitRunning(ctx, devProjectName(slug), 60*time.Second) {
		e.log("info", "Dev container is running")
		e.result(true, "", "")
		return
	}
	e.result(false, "Dev container did not reach a running state", "")
}

// StopDev stops a project's dev container (reversible — keeps the workspace +
// deps volume). Drops the staged clone token (StartDev regenerates it). Mirrors
// lib/deploy/dev.ts stopDev. The control plane stops the tunnel first (its own
// RPC) since that needs the rendered cli-data-dir context.
func (s *Service) StopDev(ctx context.Context, req *pb.StopDevRequest) (*pb.StackResult, error) {
	slug := req.GetSlug()
	if slug == "" {
		return nil, status.Error(codes.InvalidArgument, "slug is required")
	}
	s.stopDevContainer(ctx, slug)
	// Drop the staged clone token — StartDev regenerates a fresh one on restart.
	_ = os.Remove(s.cloneSecretPath(slug))
	return &pb.StackResult{Ok: true}, nil
}

// stopDevContainer brings the dev stack down, falling back to a bare `rm -f`.
func (s *Service) stopDevContainer(ctx context.Context, slug string) {
	stackFile := s.devStackFile(slug)
	res, err := dockercli.Run(ctx, 90*time.Second,
		"compose", "-p", devProjectName(slug), "-f", stackFile, "down", "--remove-orphans")
	if err != nil || res.Code != 0 {
		_, _ = dockercli.Run(ctx, 30*time.Second, "rm", "-f", devProjectName(slug))
	}
}

// TeardownDev fully tears a project's dev container down on PROJECT DELETE: stop
// the stack, remove the stack file + deps volume, WIPE the workspace dir. The
// gateway singleton is NOT torn down here (its users go via DeprovisionSshUser).
// Mirrors lib/deploy/dev.ts teardownDev.
func (s *Service) TeardownDev(ctx context.Context, req *pb.TeardownDevRequest) (*pb.StackResult, error) {
	slug := req.GetSlug()
	if slug == "" {
		return nil, status.Error(codes.InvalidArgument, "slug is required")
	}
	s.stopDevContainer(ctx, slug)
	_, _ = dockercli.Run(ctx, 30*time.Second, "volume", "rm", "-f", depsVolume(slug))
	_ = os.Remove(s.devStackFile(slug))
	_ = os.Remove(s.cloneSecretPath(slug))
	_ = os.RemoveAll(s.workspaceDir(slug))
	return &pb.StackResult{Ok: true}, nil
}

// ensureDevEntry writes the bind-mounted dev entrypoint (0755), idempotently.
// The body is rendered by the control plane (single source of truth).
func (s *Service) ensureDevEntry(script string) error {
	if script == "" {
		return fmt.Errorf("empty dev entrypoint script")
	}
	dir := filepath.Dir(s.devEntryPath())
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(s.devEntryPath(), []byte(script), 0o755); err != nil {
		return err
	}
	return os.Chmod(s.devEntryPath(), 0o755)
}

// writeCloneSecret stages the tokenized clone URL to a root-owned 0600 file, or
// removes a stale one when `url` is empty (no longer a git source). Mirrors
// lib/deploy/dev.ts writeCloneSecret — but the URL is already tokenized by the
// control plane (it mints the GitHub App token; the agent never holds the key).
func (s *Service) writeCloneSecret(slug, url string) error {
	path := s.cloneSecretPath(slug)
	if url == "" {
		_ = os.Remove(path)
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(path, []byte(url), 0o600); err != nil {
		return err
	}
	return os.Chmod(path, 0o600)
}

// materializeDevWorkspace copies the dev workspace into a fresh build dir for a
// "deploy from dev workspace" (SOURCE_KIND_DEV_WORKSPACE), EXCLUDING the
// non-source entries and rejecting any symlink (the tree is developer-controlled
// — UID 1000 shell/SSH/VS Code access — so it is treated EXACTLY like an uploaded
// archive). Mirrors lib/deploy/dev.ts copyWorkspaceForBuild. Returns the build
// dir + a cleanup func; errors if the workspace is missing or holds no source.
func (s *Service) materializeDevWorkspace(slug, subdir string, e *emitter) (string, func(), error) {
	ws := s.workspaceDir(slug)
	ents, err := os.ReadDir(ws)
	if err != nil {
		return "", func() {}, fmt.Errorf("dev workspace not found — start the dev container before deploying from it")
	}
	var sources []string
	for _, d := range ents {
		if _, skip := workspaceBuildExclude[d.Name()]; skip {
			continue
		}
		sources = append(sources, d.Name())
	}
	if len(sources) == 0 {
		return "", func() {}, fmt.Errorf("dev workspace is empty — nothing to deploy")
	}

	dir, err := os.MkdirTemp(s.buildTmpDir, "deplo-devws-"+slug+"-")
	if err != nil {
		return "", func() {}, err
	}
	cleanup := func() { _ = os.RemoveAll(dir) }
	for _, name := range sources {
		e.log("info", "copy "+name)
		if err := copyTreeNoSymlinks(filepath.Join(ws, name), filepath.Join(dir, name)); err != nil {
			cleanup()
			return "", func() {}, err
		}
	}

	// Apply the rootDirectory subdir (the project's build.rootDirectory),
	// re-validated to stay inside the build dir — the subdir arrived off the wire,
	// never trusted. Mirrors materializeGit's subdir handling.
	buildDir := dir
	if sub := strings.TrimSpace(subdir); sub != "" {
		joined, ok := safepath.Join(dir, sub)
		if !ok {
			cleanup()
			return "", func() {}, fmt.Errorf("dev workspace subdir %q escapes the build context", sub)
		}
		// Stat the LEXICALLY-joined path (safepath.Join already rejected any ".."),
		// not the Inside result — Inside collapses a NON-EXISTENT path to the root,
		// which would silently build the whole workspace for a typo'd rootDirectory.
		info, statErr := os.Stat(joined)
		if statErr != nil || !info.IsDir() {
			cleanup()
			return "", func() {}, fmt.Errorf("rootDirectory %q was not found in the dev workspace", sub)
		}
		// Now that it exists, realpath-guard it against a planted symlink escaping
		// the build dir (canonicalRoot is the package's realpath-of-root helper).
		real, _ := safepath.Inside(dir, joined)
		if real == canonicalRoot(dir) && joined != dir {
			cleanup()
			return "", func() {}, fmt.Errorf("dev workspace subdir %q escapes the build context", sub)
		}
		buildDir = real
	}
	return buildDir, cleanup, nil
}

// copyTreeNoSymlinks copies src to dst recursively, REJECTING (not following,
// not preserving) any symlink — the developer's tree is attacker-controlled, so a
// planted `leak -> /data/dev/_secrets/<slug>.url` (or `-> /`) plus a `COPY leak`
// in the Dockerfile would bake a host secret into the user's own image. This is
// the Go twin of lib/deploy/dev.ts's `cp` + `rejectSymlinks(destDir)`.
func copyTreeNoSymlinks(src, dst string) error {
	return filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		// A symlink ANYWHERE in the tree is fatal (matches rejectSymlinks, which
		// walks the whole destination and throws on the first link).
		if d.Type()&fs.ModeSymlink != 0 {
			return fmt.Errorf("dev workspace contains a symlink (%s), which is not allowed in a build context", p)
		}
		rel, err := filepath.Rel(src, p)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		if !d.Type().IsRegular() {
			// Sockets/devices/fifos: skip silently (a build context can't use them).
			return nil
		}
		in, err := os.Open(p)
		if err != nil {
			return err
		}
		defer in.Close()
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
		if err != nil {
			return err
		}
		defer out.Close()
		_, err = io.Copy(out, in)
		return err
	})
}

// workspaceHasSource reports whether the workspace holds REAL source — any entry
// outside workspaceBuildExclude. Mirrors lib/deploy/dev.ts workspaceHasSource and
// gates the once-only upload seed (user edits are never clobbered).
func (s *Service) workspaceHasSource(slug string) bool {
	ents, err := os.ReadDir(s.workspaceDir(slug))
	if err != nil {
		return false
	}
	for _, d := range ents {
		if _, skip := workspaceBuildExclude[d.Name()]; !skip {
			return true
		}
	}
	return false
}

// seedUploadWorkspace extracts the streamed archive into the (empty) workspace
// host-side, ONLY when it holds no source yet (clone-once semantics — never clobber
// user edits). The same anti-escape guards as materializeUpload apply (no
// absolute paths, no "..", no symlinks). Mirrors lib/deploy/dev.ts
// seedUploadWorkspace. The control plane only sends upload_tar for an upload
// source, so a non-empty tar here is always meant for this workspace.
func (s *Service) seedUploadWorkspace(slug string, tarBytes []byte, e *emitter) error {
	if s.workspaceHasSource(slug) {
		return nil // already seeded; leave the user's tree intact
	}
	ws := s.workspaceDir(slug)
	if err := os.MkdirAll(ws, 0o755); err != nil {
		return err
	}
	e.log("info", "Seeding workspace from upload…")
	tr := tar.NewReader(bytes.NewReader(tarBytes))
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("read upload archive: %w", err)
		}
		if hdr.Typeflag == tar.TypeSymlink || hdr.Typeflag == tar.TypeLink {
			return fmt.Errorf("upload archive contains a link entry (%s), which is not allowed", hdr.Name)
		}
		clean := filepath.Clean("/" + hdr.Name) // anchor, strips any leading ..
		target := filepath.Join(ws, clean)
		if target != ws && !strings.HasPrefix(target, ws+string(os.PathSeparator)) {
			return fmt.Errorf("upload entry %q escapes the workspace", hdr.Name)
		}
		// Never overwrite the deps-volume mountpoint / persisted dev state.
		base := strings.SplitN(strings.TrimPrefix(clean, "/"), "/", 2)[0]
		if _, skip := workspaceBuildExclude[base]; skip {
			continue
		}
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			f, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
			if err != nil {
				return err
			}
			if _, err := io.Copy(f, tr); err != nil {
				f.Close()
				return err
			}
			f.Close()
		}
	}
	return nil
}

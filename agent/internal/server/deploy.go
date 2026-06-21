package server

import (
	"archive/tar"
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	pb "github.com/idradev/deplo/agent/gen"
	"github.com/idradev/deplo/agent/internal/dockercli"
	"github.com/idradev/deplo/agent/internal/safepath"
)

// emitter funnels DeployEvents back over the gRPC stream. A small indirection so
// the deploy steps below don't each carry the grpc stream type.
type emitter struct {
	send func(*pb.DeployEvent) error
}

func (e *emitter) log(level, text string) {
	_ = e.send(&pb.DeployEvent{Event: &pb.DeployEvent_Log{
		Log: &pb.LogLine{Level: level, Text: text},
	}})
}

func (e *emitter) phase(p pb.DeployPhase) {
	_ = e.send(&pb.DeployEvent{Event: &pb.DeployEvent_Phase{
		Phase: &pb.PhaseChange{Phase: p},
	}})
}

func (e *emitter) result(ready bool, errMsg, commitSha string) {
	_ = e.send(&pb.DeployEvent{Event: &pb.DeployEvent_Result{
		Result: &pb.DeployResult{Ready: ready, Error: errMsg, CommitSha: commitSha},
	}})
}

// runDeploy is the agent-side counterpart of the control plane's runDeployment
// exec body (lib/deploy/build.ts). It materialises the build context (Part A:
// an uploaded tar, or an image to run as-is), builds the image when the request
// asks for a Dockerfile build, writes the rendered compose + env-file, brings
// the stack up, and waits for it to run — streaming logs/phases the whole way.
// The control plane stays the source of truth: it already rendered the compose
// (D2) and decrypted the env (D4); the agent never re-implements that logic.
func (s *Service) runDeploy(ctx context.Context, req *pb.DeployRequest, e *emitter) {
	slug := req.GetSlug()
	if slug == "" {
		e.result(false, "deploy request missing slug", "")
		return
	}
	name := "deplo-" + slug
	stackFile := filepath.Join(s.stackDir, slug+".yml")

	if err := os.MkdirAll(s.stackDir, 0o755); err != nil {
		e.result(false, "create stack dir: "+err.Error(), "")
		return
	}
	if err := dockercli.EnsureNetwork(ctx, "deplo"); err != nil {
		e.result(false, "ensure network: "+err.Error(), "")
		return
	}

	imageRef := req.GetImageRef()
	// commitSha is reported in the terminal result for a GIT source (the agent
	// resolves it after cloning); empty for UPLOAD/IMAGE (the control plane
	// already knows the sha, or there is none).
	commitSha := ""

	// --- Phase: prepare the image (build from context, or pull/run as-is). ---
	e.phase(pb.DeployPhase_DEPLOY_PHASE_PREPARING)
	switch req.GetSourceKind() {
	case pb.SourceKind_SOURCE_KIND_IMAGE:
		if req.GetPullImage() {
			e.log("command", "docker pull "+imageRef)
			code, err := dockercli.Stream(ctx, 10*time.Minute, func(l string) { e.log("info", l) }, "", "pull", imageRef)
			if err != nil {
				e.result(false, "docker pull: "+err.Error(), "")
				return
			}
			if code != 0 {
				e.result(false, fmt.Sprintf("docker pull failed (exit %d)", code), "")
				return
			}
		}
	case pb.SourceKind_SOURCE_KIND_UPLOAD:
		buildDir, cleanup, err := s.materializeUpload(req.GetContextTar(), slug)
		if err != nil {
			e.result(false, "materialise context: "+err.Error(), "")
			return
		}
		defer cleanup()
		if !s.buildImage(ctx, req, buildDir, e) {
			return // buildImage already emitted the failure result
		}
	case pb.SourceKind_SOURCE_KIND_GIT:
		// Part B (D3): the agent clones the repo ITSELF with a short-lived token,
		// resolves the commit sha, then builds exactly like the UPLOAD path.
		buildDir, sha, cleanup, err := s.materializeGit(ctx, req.GetGit(), slug, e)
		if err != nil {
			e.result(false, "git clone: "+err.Error(), "")
			return
		}
		defer cleanup()
		commitSha = sha
		if sha != "" {
			e.log("info", "Checked out "+shortSha(sha))
		}
		if !s.buildImage(ctx, req, buildDir, e) {
			return // buildImage already emitted the failure result
		}
	default:
		e.result(false, "unknown source kind", "")
		return
	}

	// --- Phase: write the rendered stack and bring it up. ---
	e.phase(pb.DeployPhase_DEPLOY_PHASE_STARTING)
	if req.GetComposeYaml() == "" {
		e.result(false, "deploy request missing rendered compose", "")
		return
	}
	if err := os.WriteFile(stackFile, []byte(req.GetComposeYaml()), 0o644); err != nil {
		e.result(false, "write stack file: "+err.Error(), "")
		return
	}

	// The single-image stack already bakes env into its `environment:` map (the
	// control plane rendered it that way), so no --env-file is needed here. The
	// env map still rides along for the future compose-stack path.
	composeArgs := []string{"compose", "-p", name, "-f", stackFile, "up", "-d", "--remove-orphans"}
	e.log("command", "docker compose up -d")
	code, err := dockercli.Stream(ctx, 5*time.Minute, func(l string) { e.log("info", l) }, "", composeArgs...)
	if err != nil {
		e.result(false, "compose up: "+err.Error(), "")
		return
	}
	if code != 0 {
		e.result(false, fmt.Sprintf("docker compose up failed (exit %d)", code), "")
		return
	}

	// --- Phase: wait for the container to report running. ---
	e.phase(pb.DeployPhase_DEPLOY_PHASE_WAITING)
	e.log("info", "Waiting for the container to become healthy…")
	timeout := time.Duration(req.GetReadyTimeoutMs()) * time.Millisecond
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	if waitRunning(ctx, name, timeout) {
		e.result(true, "", commitSha)
		return
	}
	e.result(false, "Container did not reach a running state", commitSha)
}

func shortSha(sha string) string {
	if len(sha) > 12 {
		return sha[:12]
	}
	return sha
}

// buildImage builds req.image_ref from a Dockerfile in buildDir. Returns false
// (after emitting a failure result) on any error. Mirrors builders.ts'
// buildFromDockerfile / buildGenerated for the Dockerfile family — the most
// common path. Other build methods stay on the control plane in Part A.
func (s *Service) buildImage(ctx context.Context, req *pb.DeployRequest, buildDir string, e *emitter) bool {
	if req.GetBuildKind() != pb.BuildKind_BUILD_KIND_DOCKERFILE {
		e.result(false, "this agent only builds the Dockerfile method in Part A", "")
		return false
	}
	df := req.GetDockerfile()
	labels := []string{
		"--label", "deplo.managed=true",
		"--label", "deplo.project=" + req.GetProjectId(),
		"--label", "deplo.slug=" + req.GetSlug(),
	}

	e.phase(pb.DeployPhase_DEPLOY_PHASE_BUILDING)

	// Generated Dockerfile: the control plane rendered the body (single source of
	// truth for framework presets); write it into the context, then build it.
	if df.GetGenerated() {
		dfPath := filepath.Join(buildDir, "Dockerfile")
		if _, err := os.Stat(dfPath); err != nil {
			if err := os.WriteFile(dfPath, []byte(df.GetGeneratedDockerfile()), 0o644); err != nil {
				e.result(false, "write generated Dockerfile: "+err.Error(), "")
				return false
			}
			e.log("info", "No Dockerfile found — using one generated from build settings")
		}
		args := append([]string{"build", "-t", req.GetImageRef()}, labels...)
		args = append(args, buildDir)
		return s.runBuild(ctx, args, e)
	}

	// Explicit Dockerfile path + context, each re-validated to stay inside the
	// context tree (path arrived off the wire — never trusted).
	dockerfilePath, ok := safepath.Join(buildDir, orDefault(df.GetDockerfilePath(), "Dockerfile"))
	if !ok {
		e.result(false, "dockerfile path escapes the build context", "")
		return false
	}
	contextDir, ok := safepath.Join(buildDir, orDefault(df.GetContextPath(), "."))
	if !ok {
		e.result(false, "build context path escapes the build context", "")
		return false
	}
	// realpath guard now that the parent exists.
	if cd, err := safepath.Inside(buildDir, contextDir); err == nil {
		contextDir = cd
	}
	if _, err := os.Stat(dockerfilePath); err != nil {
		e.result(false, fmt.Sprintf("No Dockerfile at %q in the build context", df.GetDockerfilePath()), "")
		return false
	}

	args := []string{"build", "-f", dockerfilePath}
	if stage := strings.TrimSpace(df.GetTargetStage()); stage != "" {
		args = append(args, "--target", stage)
	}
	args = append(args, "-t", req.GetImageRef())
	args = append(args, labels...)
	args = append(args, contextDir)
	return s.runBuild(ctx, args, e)
}

func (s *Service) runBuild(ctx context.Context, args []string, e *emitter) bool {
	e.log("command", "docker "+strings.Join(args, " "))
	code, err := dockercli.Stream(ctx, 15*time.Minute, func(l string) { e.log("info", l) }, "", args...)
	if err != nil {
		e.result(false, "docker build: "+err.Error(), "")
		return false
	}
	if code != 0 {
		e.result(false, fmt.Sprintf("docker build failed (exit %d)", code), "")
		return false
	}
	return true
}

// materializeUpload extracts a tar archive (the streamed build context) into a
// fresh temp dir, rejecting any entry that would escape it (absolute paths,
// "..", and symlinks — same threat model as the control plane's extractArchive).
// Returns the build dir and a cleanup func.
func (s *Service) materializeUpload(tarBytes []byte, slug string) (string, func(), error) {
	dir, err := os.MkdirTemp(s.buildTmpDir, "deplo-build-"+slug+"-")
	if err != nil {
		return "", func() {}, err
	}
	cleanup := func() { _ = os.RemoveAll(dir) }

	tr := tar.NewReader(bytes.NewReader(tarBytes))
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			cleanup()
			return "", func() {}, fmt.Errorf("read tar: %w", err)
		}
		// Reject symlinks/hardlinks outright — they are the escape vector.
		if hdr.Typeflag == tar.TypeSymlink || hdr.Typeflag == tar.TypeLink {
			cleanup()
			return "", func() {}, fmt.Errorf("archive contains a link entry (%s), which is not allowed", hdr.Name)
		}
		clean := filepath.Clean("/" + hdr.Name) // anchor, strips any leading ..
		target := filepath.Join(dir, clean)
		if target != dir && !strings.HasPrefix(target, dir+string(os.PathSeparator)) {
			cleanup()
			return "", func() {}, fmt.Errorf("archive entry %q escapes the build dir", hdr.Name)
		}
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				cleanup()
				return "", func() {}, err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				cleanup()
				return "", func() {}, err
			}
			f, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
			if err != nil {
				cleanup()
				return "", func() {}, err
			}
			if _, err := io.Copy(f, tr); err != nil {
				f.Close()
				cleanup()
				return "", func() {}, err
			}
			f.Close()
		}
	}
	return dir, cleanup, nil
}

func waitRunning(ctx context.Context, name string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if dockercli.IsRunning(ctx, name) {
			return true
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(2 * time.Second):
		}
	}
	return false
}

func orDefault(v, def string) string {
	if strings.TrimSpace(v) == "" {
		return def
	}
	return v
}

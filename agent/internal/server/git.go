package server

import (
	"bufio"
	"context"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"time"

	pb "github.com/idradev/deplo/agent/gen"
	"github.com/idradev/deplo/agent/internal/safepath"
)

// materializeGit clones a git source (PLAN Part B, D3): the agent clones the
// repo ITSELF with a short-lived token the control plane minted, so a remote
// build never ships the whole repo over the wire. It returns the build dir
// (the clone root, or a sub-directory of it), the resolved commit sha, and a
// cleanup func. The token is injected into the URL only if the URL does not
// already carry one (a GitHub App URL arrives pre-authenticated), and is NEVER
// logged — the emitted command line is sanitised.
func (s *Service) materializeGit(
	ctx context.Context,
	g *pb.GitSource,
	slug string,
	e *emitter,
) (buildDir string, commitSha string, cleanup func(), err error) {
	if g == nil || strings.TrimSpace(g.GetUrl()) == "" {
		return "", "", func() {}, fmt.Errorf("git source missing url")
	}
	dir, mkErr := os.MkdirTemp(s.buildTmpDir, "deplo-git-"+slug+"-")
	if mkErr != nil {
		return "", "", func() {}, mkErr
	}
	cleanup = func() { _ = os.RemoveAll(dir) }

	cloneURL, display := authenticatedURL(g.GetUrl(), g.GetToken())

	// Clone shallowly at the requested branch. A shallow single-branch clone is
	// the smallest fetch that still yields a working tree + the tip commit sha.
	args := []string{"clone", "--depth", "1"}
	if b := strings.TrimSpace(g.GetBranch()); b != "" {
		args = append(args, "--branch", b, "--single-branch")
	}
	args = append(args, cloneURL, dir)

	// Log the SANITISED command (the real URL with the token is never emitted).
	branchNote := ""
	if b := strings.TrimSpace(g.GetBranch()); b != "" {
		branchNote = " (" + b + ")"
	}
	e.log("command", "git clone "+display+branchNote)

	if err := runGit(ctx, e, "", args...); err != nil {
		cleanup()
		return "", "", func() {}, err
	}

	// Resolve the checked-out commit sha (reported back so the control plane can
	// write it to the Deployment row — proto DeployResult.commit_sha).
	sha, _ := gitOutput(ctx, dir, "rev-parse", "HEAD")
	commitSha = strings.TrimSpace(sha)

	// Apply the optional sub-directory (the project's rootDirectory), validated to
	// stay inside the clone — the subdir arrived off the wire, never trusted.
	buildDir = dir
	if sub := strings.TrimSpace(g.GetSubdir()); sub != "" {
		joined, ok := safepath.Join(dir, sub)
		if !ok {
			cleanup()
			return "", "", func() {}, fmt.Errorf("git subdir %q escapes the clone", sub)
		}
		if real, rErr := safepath.Inside(dir, joined); rErr == nil {
			joined = real
		}
		info, statErr := os.Stat(joined)
		if statErr != nil || !info.IsDir() {
			cleanup()
			return "", "", func() {}, fmt.Errorf("git subdir %q was not found in the repository", sub)
		}
		buildDir = joined
	}
	return buildDir, commitSha, cleanup, nil
}

// authenticatedURL returns (cloneURL, displayURL). If the URL already carries
// credentials (a GitHub App x-access-token URL from the control plane), it is
// used as-is. Otherwise, when a token is supplied, it is injected as the
// x-access-token userinfo. The display URL always has credentials stripped so a
// token never reaches a log line.
func authenticatedURL(raw, token string) (cloneURL, display string) {
	u, err := url.Parse(raw)
	if err != nil {
		// Not a parseable URL (e.g. scp-like git@host:repo) — pass through, and
		// display as-is (no userinfo to leak in that form).
		return raw, raw
	}
	// Strip any credentials for display.
	disp := *u
	disp.User = nil
	display = disp.String()

	if u.User != nil && u.User.Username() != "" {
		// Already authenticated — keep it.
		return raw, display
	}
	if strings.TrimSpace(token) != "" {
		u.User = url.UserPassword("x-access-token", token)
		return u.String(), display
	}
	return raw, display
}

// runGit runs a git command, streaming combined output line-by-line as info
// logs (so the operator sees clone progress). Token-bearing URLs are passed only
// in argv, never echoed (the caller logs a sanitised line). dir="" runs in the
// process cwd (used for the clone itself, whose target is an arg).
func runGit(ctx context.Context, e *emitter, dir string, args ...string) error {
	cctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(cctx, "git", args...)
	if dir != "" {
		cmd.Dir = dir
	}
	// GIT_TERMINAL_PROMPT=0: never block on an interactive credential prompt (a
	// bad/expired token must fail fast, not hang the deploy).
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	stdout, _ := cmd.StdoutPipe()
	cmd.Stderr = cmd.Stdout // fold stderr into the same stream for ordered logs
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("git: %w", err)
	}
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		e.log("info", sanitizeGitLine(scanner.Text()))
	}
	if err := cmd.Wait(); err != nil {
		return fmt.Errorf("git %s failed: %w", args[0], err)
	}
	return nil
}

// gitOutput runs a git command and returns its trimmed stdout (no streaming).
func gitOutput(ctx context.Context, dir string, args ...string) (string, error) {
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(cctx, "git", args...)
	cmd.Dir = dir
	out, err := cmd.Output()
	return string(out), err
}

// sanitizeGitLine strips anything that looks like an x-access-token credential
// from a log line, as belt-and-suspenders — git should not echo the URL, but a
// defensive scrub guarantees a token never lands in the deployment log.
func sanitizeGitLine(line string) string {
	if i := strings.Index(line, "x-access-token:"); i >= 0 {
		if at := strings.Index(line[i:], "@"); at >= 0 {
			return line[:i] + "x-access-token:***@" + line[i+at+1:]
		}
	}
	return line
}

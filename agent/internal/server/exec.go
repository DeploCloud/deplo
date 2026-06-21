package server

import (
	"context"
	"regexp"
	"strings"
	"sync"
	"time"

	pb "github.com/idradev/deplo/agent/gen"
	"github.com/idradev/deplo/agent/internal/dockercli"
)

// exec.go ports the container-exec half of lib/infra/docker.ts to the agent:
// resolveShellPlan / shellLabel / splitArgv / execInContainer / isDockerLevelStderr.
// The logic mirrors the TS exactly so a remote console behaves identically to the
// local one — same shell detection, same raw-argv fallback on distroless, same
// docker-vs-guest error classification.

// dockerLevelStderr matches stderr emitted by docker / the OCI runtime (never by
// an in-container shell), used to tell a docker-level failure (container gone,
// no shell) from a guest command exiting non-zero. Ported verbatim from
// lib/infra/docker.ts DOCKER_LEVEL_STDERR.
var dockerLevelStderr = regexp.MustCompile(
	`(?m)(?:OCI runtime|unable to start container process|executable file not found in \$PATH|Error response from daemon|No such container|is not running|is paused|Cannot connect to the Docker daemon|cannot exec in a stopped|container .* is (?:not running|paused|restarting)|chdir to cwd .* set in config\.json failed)`,
)

func isDockerLevelStderr(s string) bool {
	return dockerLevelStderr.MatchString(s)
}

// shellPlan is the resolved way to run a command in a container: via a detected
// shell (run is the argv prefix, e.g. ["sh","-lc"]) or raw argv when the image
// has none (distroless/scratch).
type shellPlan struct {
	// run is the shell argv prefix; nil means raw (no shell).
	run []string
}

func (p shellPlan) raw() bool { return p.run == nil }

// shellCandidate mirrors lib/infra/docker.ts SHELL_CANDIDATES: a zero-side-effect
// probe (`-c :`) and the argv prefix used to run real commands (a login shell
// `-lc` loads PATH/profile, but is NOT used to probe).
type shellCandidate struct {
	probe []string
	run   []string
}

var shellCandidates = []shellCandidate{
	{probe: []string{"sh", "-c", ":"}, run: []string{"sh", "-lc"}},
	{probe: []string{"bash", "-c", ":"}, run: []string{"bash", "-lc"}},
	{probe: []string{"ash", "-c", ":"}, run: []string{"ash", "-lc"}},
	{probe: []string{"busybox", "sh", "-c", ":"}, run: []string{"busybox", "sh", "-c"}},
}

const shellTTL = 5 * time.Minute

type shellCacheEntry struct {
	plan  shellPlan
	image string
	at    time.Time
}

var (
	shellCacheMu sync.Mutex
	// Keyed by container name. A redeploy yields a new name, so the cache
	// self-expires; the image is also compared so a same-name re-pull re-probes.
	// (Container names are globally unique on one daemon, so name alone is a safe
	// key — no need to compound with the project.)
	shellCache = map[string]shellCacheEntry{}
)

// resolveShellPlan determines how to run commands in a container — via a detected
// shell, or raw argv when none exists — probed once per container and cached
// (keyed by name; re-probes on image change or TTL lapse). Mirrors the TS
// resolveShellPlan, including the "don't cache a transient/ docker-level failure"
// discipline so a stopped-then-restarted container re-probes.
func resolveShellPlan(ctx context.Context, name, image string) shellPlan {
	shellCacheMu.Lock()
	hit, ok := shellCache[name]
	shellCacheMu.Unlock()
	if ok && hit.image == image && time.Since(hit.at) < shellTTL {
		return hit.plan
	}

	plan := shellPlan{run: nil} // raw by default
	for _, c := range shellCandidates {
		args := append([]string{"exec", name}, c.probe...)
		res, err := dockercli.Run(ctx, 5*time.Second, args...)
		if err != nil {
			// Spawn failure / timeout / daemon unreachable: can't probe. Don't
			// cache a possibly-transient result — treat as raw for this attempt.
			return shellPlan{run: nil}
		}
		if res.Code == 0 {
			plan = shellPlan{run: c.run}
			break
		}
		// A docker-level error (container stopped/removed) fails every probe
		// identically — bail without caching so a later restart re-probes.
		if isDockerLevelStderr(res.Stderr) {
			return shellPlan{run: nil}
		}
	}
	shellCacheMu.Lock()
	shellCache[name] = shellCacheEntry{plan: plan, image: image, at: time.Now()}
	shellCacheMu.Unlock()
	return plan
}

// shellLabelFor mirrors lib/infra/docker.ts shellLabel.
func shellLabelFor(ctx context.Context, name, image string) string {
	plan := resolveShellPlan(ctx, name, image)
	if plan.raw() {
		return "raw exec (no shell)"
	}
	if plan.run[0] == "bash" {
		return "/bin/bash"
	}
	return "/bin/sh"
}

// splitArgv mirrors lib/infra/docker.ts splitArgv: honours single/double quotes,
// performs NO expansion (no globbing/$VAR/pipes/redirects). Intentionally minimal.
func splitArgv(s string) []string {
	out := []string{}
	var cur strings.Builder
	var quote rune // 0 when not in a quote
	has := false
	for _, ch := range s {
		switch {
		case quote != 0:
			if ch == quote {
				quote = 0
			} else {
				cur.WriteRune(ch)
			}
			has = true
		case ch == '"' || ch == '\'':
			quote = ch
			has = true
		case ch == ' ' || ch == '\t':
			if has {
				out = append(out, cur.String())
				cur.Reset()
				has = false
			}
		default:
			cur.WriteRune(ch)
			has = true
		}
	}
	if has {
		out = append(out, cur.String())
	}
	return out
}

// Exec runs a command in a container (docker exec), mirroring
// lib/infra/docker.ts execInContainer + lib/data/console.ts execInContainer's
// shell/raw dispatch. A guest non-zero exit is returned in ExecResponse.code (NOT
// an RPC error) so the console renders it; a docker/OCI-level failure (no such
// container, no shell, stopped) is a gRPC error.
func (s *Service) Exec(ctx context.Context, req *pb.ExecRequest) (*pb.ExecResponse, error) {
	if err := assertOwned(ctx, req.GetContainer(), req.GetProjectId()); err != nil {
		return nil, err
	}
	name := req.GetContainer()
	command := strings.TrimSpace(req.GetCommand())
	if command == "" {
		return &pb.ExecResponse{Code: 0, RawMode: false}, nil
	}

	plan := resolveShellPlan(ctx, name, req.GetImage())
	if !plan.raw() {
		args := append(append([]string{"exec", name}, plan.run...), command)
		res, err := dockercli.Run(ctx, 30*time.Second, args...)
		if err != nil {
			return nil, err // spawn/timeout: docker never produced an exit code
		}
		return &pb.ExecResponse{
			Code:    int32(res.Code),
			Stdout:  res.Stdout,
			Stderr:  res.Stderr,
			RawMode: false,
		}, nil
	}

	// Raw (shell-less) exec: the first word is the binary, the rest literal args.
	argv := splitArgv(command)
	if len(argv) == 0 {
		return &pb.ExecResponse{Code: 0, RawMode: true}, nil
	}
	args := append([]string{"exec", name}, argv...)
	res, err := dockercli.Run(ctx, 30*time.Second, args...)
	if err != nil {
		return nil, err
	}
	return &pb.ExecResponse{
		Code:    int32(res.Code),
		Stdout:  res.Stdout,
		Stderr:  res.Stderr,
		RawMode: true,
	}, nil
}

// ShellLabel returns the default/chosen container's shell label for the banner.
func (s *Service) ShellLabel(ctx context.Context, req *pb.ShellLabelRequest) (*pb.ShellLabelResponse, error) {
	if err := assertOwned(ctx, req.GetContainer(), req.GetProjectId()); err != nil {
		return nil, err
	}
	return &pb.ShellLabelResponse{
		Label: shellLabelFor(ctx, req.GetContainer(), req.GetImage()),
	}, nil
}

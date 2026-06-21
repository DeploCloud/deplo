package server

import (
	"context"
	"encoding/json"
	"sort"
	"strings"
	"time"

	pb "github.com/idradev/deplo/agent/gen"
	"github.com/idradev/deplo/agent/internal/dockercli"
)

// instances.go ports lib/data/console.ts listInstances (+ the inspectRuntime /
// inspectStdio / serviceOf helpers from lib/infra/docker.ts) to the agent. It
// lists every attachable container in a project's stack with the runtime/stdio
// metadata the console needs, ordered exposed -> running -> service.
//
// DELIBERATELY no synthetic fallback entry: when a project has no containers the
// response is empty. The TS listInstances returns ONE fabricated entry so the
// console still renders a name — that is a control-plane UI affordance and stays
// control-plane-side, LOCALHOST-ONLY. Fabricating a container for a remote would
// be the "stored status that lies" the plan forbids; a remote with no containers
// truthfully reports none.

// ListInstances enumerates a project's attachable containers.
func (s *Service) ListInstances(ctx context.Context, req *pb.ListInstancesRequest) (*pb.ListInstancesResponse, error) {
	projectID := req.GetProjectId()
	cs, err := listProjectContainers(ctx, projectID)
	if err != nil {
		return nil, err
	}
	out := make([]*pb.ConsoleInstance, 0, len(cs))
	for _, c := range cs {
		user, workdir := inspectRuntime(ctx, c.Name)
		openStdin, tty := inspectStdio(ctx, c.Name)
		exposed := false
		if req.GetExposeService() != "" {
			exposed = strings.Contains(c.Name, "-"+req.GetExposeService()+"-")
		}
		out = append(out, &pb.ConsoleInstance{
			Name:      c.Name,
			Service:   serviceOf(req.GetSlug(), c.Name),
			Image:     c.Image,
			Running:   c.State == "running",
			Exposed:   exposed,
			User:      user,
			Workdir:   workdir,
			OpenStdin: openStdin,
			Tty:       tty,
		})
	}
	// Exposed app first, then running, then alphabetical by service — the same
	// order listInstances produces (so instances[0] is the default target).
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.Exposed != b.Exposed {
			return a.Exposed
		}
		if a.Running != b.Running {
			return a.Running
		}
		return a.Service < b.Service
	})
	return &pb.ListInstancesResponse{Instances: out}, nil
}

type containerRow struct {
	Name  string
	Image string
	State string
}

// listProjectContainers runs `docker ps -a --filter label=deplo.project=<id>`
// and parses the JSON lines, mirroring lib/infra/docker.ts listContainers.
func listProjectContainers(ctx context.Context, projectID string) ([]containerRow, error) {
	args := []string{"ps", "-a", "--format", "{{json .}}"}
	if projectID != "" {
		args = append(args, "--filter", "label=deplo.project="+projectID)
	}
	res, err := dockercli.Run(ctx, 15*time.Second, args...)
	if err != nil {
		return nil, err
	}
	rows := []containerRow{}
	for _, line := range strings.Split(strings.TrimSpace(res.Stdout), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var raw struct {
			Names string `json:"Names"`
			Image string `json:"Image"`
			State string `json:"State"`
		}
		if err := json.Unmarshal([]byte(line), &raw); err != nil {
			continue
		}
		rows = append(rows, containerRow{Name: raw.Names, Image: raw.Image, State: raw.State})
	}
	return rows, nil
}

// serviceOf extracts the compose service name from a container name
// (deplo-<slug>-<service>-N), falling back to the slug for single-image deploys.
// Mirrors lib/data/console.ts serviceOf.
func serviceOf(slug, containerName string) string {
	prefix := "deplo-" + slug + "-"
	if strings.HasPrefix(containerName, prefix) {
		rest := containerName[len(prefix):]
		return trimTrailingReplicaIndex(rest)
	}
	return strings.TrimPrefix(containerName, "deplo-")
}

// trimTrailingReplicaIndex strips a compose "-N" replica suffix (.replace(/-\d+$/,"")).
func trimTrailingReplicaIndex(s string) string {
	i := strings.LastIndex(s, "-")
	if i < 0 || i == len(s)-1 {
		return s
	}
	for _, ch := range s[i+1:] {
		if ch < '0' || ch > '9' {
			return s
		}
	}
	return s[:i]
}

// inspectRuntime mirrors lib/infra/docker.ts inspectRuntime: effective user +
// working dir from container metadata; defaults root/"/" on any failure.
func inspectRuntime(ctx context.Context, name string) (user, workdir string) {
	res, err := dockercli.Run(ctx, 10*time.Second,
		"inspect", "-f", "{{.Config.User}}\t{{.Config.WorkingDir}}", name)
	if err != nil || res.Code != 0 {
		return "root", "/"
	}
	parts := strings.SplitN(strings.TrimSpace(res.Stdout), "\t", 2)
	u := ""
	w := ""
	if len(parts) > 0 {
		u = strings.TrimSpace(parts[0])
	}
	if len(parts) > 1 {
		w = strings.TrimSpace(parts[1])
	}
	if u == "" {
		u = "root"
	}
	if w == "" {
		w = "/"
	}
	return u, w
}

// inspectStdio mirrors lib/infra/docker.ts inspectStdio: whether the container
// was started with stdin open / a TTY allocated; both false on any failure.
func inspectStdio(ctx context.Context, name string) (openStdin, tty bool) {
	res, err := dockercli.Run(ctx, 10*time.Second,
		"inspect", "-f", "{{.Config.OpenStdin}}\t{{.Config.Tty}}", name)
	if err != nil || res.Code != 0 {
		return false, false
	}
	parts := strings.SplitN(strings.TrimSpace(res.Stdout), "\t", 2)
	if len(parts) > 0 && strings.TrimSpace(parts[0]) == "true" {
		openStdin = true
	}
	if len(parts) > 1 && strings.TrimSpace(parts[1]) == "true" {
		tty = true
	}
	return openStdin, tty
}

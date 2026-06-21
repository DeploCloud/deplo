package server

import (
	"context"
	"strings"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/idradev/deplo/agent/internal/dockercli"
)

// assertOwned confirms that `container` carries the label deplo.project=<projectID>
// before any console RPC (FollowLogs/Attach/Exec/ShellLabel) acts on it.
//
// The control plane is the PRIMARY authorization gate — it resolves the instance
// from its own store (ListInstances filtered by deplo.project) before ever naming
// a container on the wire. This is defence in depth: even though the agent is dumb
// about Deplo's tenancy, it must never let a container NAME that arrived off the
// wire reach a container that does not belong to the stated project — so a bug or
// a forged name in the control plane can't be leveraged into cross-project access
// on the agent's daemon. PLAN D9's principle ("validate where the I/O runs, never
// trust a path/name off the wire") applied to container names.
//
// An empty projectID is rejected: a console RPC must always identify its project.
func assertOwned(ctx context.Context, container, projectID string) error {
	if container == "" {
		return status.Error(codes.InvalidArgument, "container is required")
	}
	if projectID == "" {
		return status.Error(codes.InvalidArgument, "project_id is required")
	}
	res, err := dockercli.Run(ctx, 5*time.Second,
		"inspect", "-f", `{{index .Config.Labels "deplo.project"}}`, container)
	if err != nil {
		// Docker could not run / timed out: treat as unreachable, not a denial.
		return status.Errorf(codes.Unavailable, "inspect %s: %v", container, err)
	}
	if res.Code != 0 {
		// No such container (or inspect failed): nothing to act on.
		return status.Errorf(codes.NotFound, "no such container %q", container)
	}
	got := strings.TrimSpace(res.Stdout)
	if got != projectID {
		return status.Errorf(codes.PermissionDenied,
			"container %q does not belong to project %q", container, projectID)
	}
	return nil
}

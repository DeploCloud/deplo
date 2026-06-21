package server

import (
	"context"
	"strings"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "github.com/idradev/deplo/agent/gen"
	"github.com/idradev/deplo/agent/internal/dockercli"
)

// tunnel.go ports the VS Code Remote Tunnel half of lib/deploy/dev.ts to the
// agent (PLAN Part D). `code tunnel` runs INSIDE the dev container and dials OUT
// to Microsoft's relay over HTTPS — no inbound port, no gateway change — so these
// RPCs are thin `docker exec` wrappers. The variable bit (the launch script: CLI
// download URL + tunnel name) is rendered by the control plane and sent on
// StartTunnel; the in-container tunnel paths below are a fixed convention (the
// same constants the control plane's tunnelLaunchScript writes to), the Go twin
// of the gateway container name being a constant. The LOG PARSING (device-login
// link / connected URL) stays pure in the control plane (parseTunnelLog).

const (
	// In-container tunnel state paths — mirror lib/deploy/dev.ts TUNNEL_* (under
	// /workspace/.deplo so they persist across stop/start on the workspace bind).
	tunnelDir = "/workspace/.deplo"
	tunnelLog = tunnelDir + "/tunnel.log"
	tunnelPid = tunnelDir + "/tunnel.pid"
	codeCLI   = tunnelDir + "/code"
	cliData   = tunnelDir + "/cli-data"
)

// readTunnelStatus reads the tunnel log + running flag from the container. The
// running marker mirrors getVscodeTunnel: a sentinel printed when the pid file's
// process is alive. Best-effort: an absent/never-tunnelled container reads empty.
func readTunnelStatus(ctx context.Context, slug string) *pb.TunnelStatus {
	name := devProjectName(slug)
	script := "cat " + tunnelLog + " 2>/dev/null; " +
		"if [ -f " + tunnelPid + " ] && kill -0 \"$(cat " + tunnelPid + " 2>/dev/null)\" 2>/dev/null; then echo __DEPLO_RUNNING__; fi"
	res, err := dockercli.Run(ctx, 15*time.Second, "exec", name, "/bin/sh", "-c", script)
	if err != nil {
		return &pb.TunnelStatus{Running: false, Log: ""}
	}
	out := res.Stdout
	running := strings.Contains(out, "__DEPLO_RUNNING__")
	log := strings.TrimSpace(strings.ReplaceAll(out, "__DEPLO_RUNNING__", ""))
	return &pb.TunnelStatus{Running: running, Log: log}
}

// StartTunnel launches the tunnel (idempotent) using the control-plane-rendered
// launch script, then returns the current status. Mirrors startVscodeTunnel's
// launch step; the control plane does its own brief poll loop via GetTunnel.
func (s *Service) StartTunnel(ctx context.Context, req *pb.TunnelRequest) (*pb.TunnelStatus, error) {
	slug := req.GetSlug()
	if slug == "" {
		return nil, status.Error(codes.InvalidArgument, "slug is required")
	}
	if req.GetLaunchScript() == "" {
		return nil, status.Error(codes.InvalidArgument, "launch script is required")
	}
	name := devProjectName(slug)
	// Launch as the dev user (UID 1000) so the tunnel owns its files.
	_, _ = dockercli.Run(ctx, 120*time.Second,
		"exec", "-u", "1000", "-w", "/workspace", name, "/bin/sh", "-lc", req.GetLaunchScript())
	return readTunnelStatus(ctx, slug), nil
}

// GetTunnel reads the current tunnel status (no side effects).
func (s *Service) GetTunnel(ctx context.Context, req *pb.TunnelRequest) (*pb.TunnelStatus, error) {
	if req.GetSlug() == "" {
		return nil, status.Error(codes.InvalidArgument, "slug is required")
	}
	return readTunnelStatus(ctx, req.GetSlug()), nil
}

// StopTunnel stops the tunnel process (the CLI download + auth token are kept, so
// a later Start re-uses the GitHub login). Mirrors stopVscodeTunnel — passes the
// same --cli-data-dir so `tunnel kill` acts on the same CLI state.
func (s *Service) StopTunnel(ctx context.Context, req *pb.TunnelRequest) (*pb.StackResult, error) {
	slug := req.GetSlug()
	if slug == "" {
		return nil, status.Error(codes.InvalidArgument, "slug is required")
	}
	name := devProjectName(slug)
	script := "[ -f " + tunnelPid + " ] && kill \"$(cat " + tunnelPid + ")\" 2>/dev/null; " +
		"rm -f " + tunnelPid + "; " +
		codeCLI + " tunnel --cli-data-dir " + cliData + " kill 2>/dev/null || true"
	_, _ = dockercli.Run(ctx, 20*time.Second, "exec", name, "/bin/sh", "-c", script)
	return &pb.StackResult{Ok: true}, nil
}

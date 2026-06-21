// Package server implements the Agent gRPC service — the server side of the
// second system boundary (ADR-0006). It owns the host-coupled half of the
// platform on the machine the agent runs on: Docker exec, the Dockerfile build,
// stack lifecycle, host metrics. The control plane stays the source of truth
// (it renders the compose and decrypts env); the agent stays dumb about Deplo's
// store and policy.
package server

import (
	"context"
	"fmt"
	"sync"
	"time"

	pb "github.com/idradev/deplo/agent/gen"
	"github.com/idradev/deplo/agent/internal/dockercli"
	"github.com/idradev/deplo/agent/internal/hostmetrics"
)

// Capabilities this agent advertises in Hello. The control plane routes only
// what the agent supports here through the agent path, keeping a local fallback
// for everything else (Part A: the Dockerfile build + single-image compose-up).
var Capabilities = []string{
	"deploy.dockerfile",  // builds the Dockerfile method
	"deploy.image",       // runs a prebuilt image as-is
	"deploy.compose.single", // single-image compose-up
	"metrics",
}

// AgentVersion is stamped at build time via -ldflags; "dev" by default.
var AgentVersion = "dev"

// inflight records a deploy the agent is currently running, keyed by its stable
// deploy id. Part A groundwork for D5: the record exists so a future re-attach
// RPC can find an in-progress deploy. Part A itself stays fire-and-forget.
type inflight struct {
	startedAt time.Time
	phase     pb.DeployPhase
}

// Service is the gRPC Agent implementation.
type Service struct {
	pb.UnimplementedAgentServer

	// stackDir is where rendered stack files are written (mirrors the control
	// plane's /data/stacks). buildTmpDir is where upload contexts are extracted.
	stackDir    string
	buildTmpDir string
	dataDir     string

	mu        sync.Mutex
	deploys   map[string]*inflight
}

// New builds the service. stackDir/buildTmpDir are created lazily by the deploy
// path; dataDir is the filesystem measured for disk metrics.
func New(stackDir, buildTmpDir, dataDir string) *Service {
	return &Service{
		stackDir:    stackDir,
		buildTmpDir: buildTmpDir,
		dataDir:     dataDir,
		deploys:     map[string]*inflight{},
	}
}

// Hello is the health + identity handshake and the mandatory deploy pre-flight
// (PLAN P5). It never fails: an unreachable Docker daemon is reported as
// docker_available=false, a clear "this server can't deploy" signal, rather than
// an RPC error.
func (s *Service) Hello(ctx context.Context, req *pb.HelloRequest) (*pb.HelloResponse, error) {
	available := dockercli.Available(ctx)
	version := ""
	if available {
		version = dockercli.ServerVersion(ctx)
	}
	return &pb.HelloResponse{
		ContractVersion: pb.ContractVersion_CONTRACT_VERSION_V1,
		AgentVersion:    AgentVersion,
		DockerAvailable: available,
		DockerVersion:   version,
		Capabilities:    Capabilities,
	}, nil
}

// Metrics returns a host snapshot (replaces lib/infra/host.ts per server).
func (s *Service) Metrics(ctx context.Context, req *pb.MetricsRequest) (*pb.HostMetrics, error) {
	dataDir := req.GetDataDir()
	if dataDir == "" {
		dataDir = s.dataDir
	}
	m := hostmetrics.Collect(dataDir)
	return &pb.HostMetrics{
		Cpu:               m.CPU,
		CpuCores:          int32(m.CPUCores),
		MemUsed:           m.MemUsed,
		MemTotal:          m.MemTotal,
		MemPct:            m.MemPct,
		DiskUsed:          m.DiskUsed,
		DiskTotal:         m.DiskTotal,
		DiskPct:           m.DiskPct,
		NetRx:             m.NetRx,
		NetTx:             m.NetTx,
		Load1:             m.Load1,
		Load5:             m.Load5,
		Load15:            m.Load15,
		UptimeSec:         m.UptimeSec,
		RunningContainers: int32(dockercli.RunningContainers(ctx)),
	}, nil
}

// Deploy runs a deployment and streams its events. The stream is the live build
// log + phase transitions + a terminal result; the control plane writes these
// into the Deployment row and republishes over its existing SSE subscriptions.
func (s *Service) Deploy(req *pb.DeployRequest, stream pb.Agent_DeployServer) error {
	id := req.GetDeployId()
	s.mu.Lock()
	s.deploys[id] = &inflight{startedAt: time.Now(), phase: pb.DeployPhase_DEPLOY_PHASE_UNSPECIFIED}
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.deploys, id)
		s.mu.Unlock()
	}()

	e := &emitter{send: func(ev *pb.DeployEvent) error {
		if p := ev.GetPhase(); p != nil {
			s.mu.Lock()
			if d := s.deploys[id]; d != nil {
				d.phase = p.GetPhase()
			}
			s.mu.Unlock()
		}
		return stream.Send(ev)
	}}

	// The deploy runs to completion bound to the stream's context: if the
	// control plane disconnects, the context cancels and the deploy stops. (Part
	// B keeps building through a disconnect and replays on re-attach; Part A is
	// fire-and-forget, matching today's behaviour.)
	s.runDeploy(stream.Context(), req, e)
	return nil
}

// StopStack stops a compose-managed stack (falls back to the bare container).
func (s *Service) StopStack(ctx context.Context, ref *pb.StackRef) (*pb.StackResult, error) {
	slug := ref.GetSlug()
	res, err := dockercli.Run(ctx, time.Minute, "compose", "-p", "deplo-"+slug, "-f", s.stackPath(slug), "stop")
	if err == nil && res.Code == 0 {
		return &pb.StackResult{Ok: true}, nil
	}
	r2, err2 := dockercli.Run(ctx, 30*time.Second, "stop", "deplo-"+slug)
	if err2 != nil {
		return &pb.StackResult{Ok: false, Error: err2.Error()}, nil
	}
	return &pb.StackResult{Ok: r2.Code == 0, Error: r2.Stderr}, nil
}

// StartStack starts a previously stopped stack.
func (s *Service) StartStack(ctx context.Context, ref *pb.StackRef) (*pb.StackResult, error) {
	slug := ref.GetSlug()
	res, err := dockercli.Run(ctx, time.Minute, "compose", "-p", "deplo-"+slug, "-f", s.stackPath(slug), "start")
	if err == nil && res.Code == 0 {
		return &pb.StackResult{Ok: true}, nil
	}
	r2, err2 := dockercli.Run(ctx, 30*time.Second, "start", "deplo-"+slug)
	if err2 != nil {
		return &pb.StackResult{Ok: false, Error: err2.Error()}, nil
	}
	return &pb.StackResult{Ok: r2.Code == 0, Error: r2.Stderr}, nil
}

// DestroyStack stops and removes a stack (compose down, falling back to rm -f).
func (s *Service) DestroyStack(ctx context.Context, ref *pb.StackRef) (*pb.StackResult, error) {
	slug := ref.GetSlug()
	res, err := dockercli.Run(ctx, 90*time.Second, "compose", "-p", "deplo-"+slug, "-f", s.stackPath(slug), "down", "--remove-orphans")
	if err == nil && res.Code == 0 {
		return &pb.StackResult{Ok: true}, nil
	}
	// `rm -f` is idempotent for a missing container (exit 0), so the common
	// already-gone case still reports Ok. Gate on the exit code — like
	// StopStack/StartStack — so a genuine removal failure is NOT reported as a
	// successful destroy (which would have the control plane mark a still-running
	// container destroyed).
	r2, err := dockercli.Run(ctx, 30*time.Second, "rm", "-f", "deplo-"+slug)
	if err != nil {
		return &pb.StackResult{Ok: false, Error: err.Error()}, nil
	}
	return &pb.StackResult{Ok: r2.Code == 0, Error: r2.Stderr}, nil
}

// Inspect reports a container's existence + running state for live status.
func (s *Service) Inspect(ctx context.Context, req *pb.InspectRequest) (*pb.InspectResponse, error) {
	name := "deplo-" + req.GetSlug()
	exists, state := dockercli.State(ctx, name)
	return &pb.InspectResponse{
		Exists:  exists,
		Running: state == "running",
		State:   state,
	}, nil
}

func (s *Service) stackPath(slug string) string {
	return fmt.Sprintf("%s/%s.yml", s.stackDir, slug)
}

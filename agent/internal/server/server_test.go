package server

import (
	"context"
	"net"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "github.com/idradev/deplo/agent/gen"
)

// dialLocal spins up the Agent service on an in-process listener (no TLS — the
// mTLS handshake is covered cross-language in the TS PKI tests and the harness
// integration test) and returns a connected client.
func dialLocal(t *testing.T) (pb.AgentClient, func()) {
	t.Helper()
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := grpc.NewServer()
	pb.RegisterAgentServer(srv, New(t.TempDir(), t.TempDir(), "/"))
	go srv.Serve(lis)

	conn, err := grpc.NewClient(lis.Addr().String(), grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatal(err)
	}
	return pb.NewAgentClient(conn), func() { conn.Close(); srv.Stop() }
}

func TestHello_reportsContractAndCapabilities(t *testing.T) {
	client, done := dialLocal(t)
	defer done()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	resp, err := client.Hello(ctx, &pb.HelloRequest{
		ContractVersion: pb.ContractVersion_CONTRACT_VERSION_V1,
	})
	if err != nil {
		t.Fatalf("Hello: %v", err)
	}
	if resp.GetContractVersion() != pb.ContractVersion_CONTRACT_VERSION_V1 {
		t.Errorf("contract version = %v", resp.GetContractVersion())
	}
	if len(resp.GetCapabilities()) == 0 {
		t.Error("expected capabilities to be advertised")
	}
	// docker_available may be true or false depending on the test host; the
	// point is Hello answers without error (the deploy pre-flight, PLAN P5).
}

func TestMetrics_returnsHostShape(t *testing.T) {
	client, done := dialLocal(t)
	defer done()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	m, err := client.Metrics(ctx, &pb.MetricsRequest{DataDir: "/"})
	if err != nil {
		t.Fatalf("Metrics: %v", err)
	}
	if m.GetCpuCores() < 1 {
		t.Errorf("cpu_cores = %d", m.GetCpuCores())
	}
	if m.GetMemTotal() <= 0 {
		t.Errorf("mem_total = %d", m.GetMemTotal())
	}
}

func TestDeploy_missingSlugFailsCleanly(t *testing.T) {
	client, done := dialLocal(t)
	defer done()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	stream, err := client.Deploy(ctx, &pb.DeployRequest{DeployId: "dpl_test"})
	if err != nil {
		t.Fatalf("Deploy open: %v", err)
	}
	// Expect a single terminal result event reporting the missing slug, not a
	// hang and not an RPC error.
	var sawResult bool
	for {
		ev, err := stream.Recv()
		if err != nil {
			break
		}
		if r := ev.GetResult(); r != nil {
			sawResult = true
			if r.GetReady() {
				t.Error("expected failure for missing slug")
			}
			if r.GetError() == "" {
				t.Error("expected an error message")
			}
		}
	}
	if !sawResult {
		t.Error("expected a terminal DeployResult event")
	}
}

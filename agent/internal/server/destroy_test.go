package server

import (
	"context"
	"testing"
	"time"

	pb "github.com/idradev/deplo/agent/gen"
	"github.com/idradev/deplo/agent/internal/dockercli"
)

// DestroyStack's `rm -f` fallback must report Ok based on the docker EXIT CODE,
// not merely the spawn error — otherwise a genuine non-zero removal failure is
// reported as a successful destroy. The common already-gone case (`rm -f` of a
// missing container) is idempotent (exit 0) and must still report Ok:true.
func TestDestroyStack_missingContainerReportsOk(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if !dockercli.Available(ctx) {
		t.Skip("docker not available")
	}
	s := New(t.TempDir(), t.TempDir(), "/", "")
	// No such stack/container exists: compose down has no file, rm -f is
	// idempotent (exit 0) → Ok:true, not a false failure.
	res, err := s.DestroyStack(ctx, &pb.StackRef{Slug: "definitely-not-a-real-stack-xyz"})
	if err != nil {
		t.Fatalf("DestroyStack rpc error: %v", err)
	}
	if !res.GetOk() {
		t.Errorf("destroying a missing stack should be Ok (idempotent), got Ok=false err=%q", res.GetError())
	}
}

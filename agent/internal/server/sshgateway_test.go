package server

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	pb "github.com/idradev/deplo/agent/gen"
)

func TestWriteGatewayFilesSubstitutesSentinelAndModes(t *testing.T) {
	base := t.TempDir()
	s := New(filepath.Join(base, "stacks"), filepath.Join(base, "tmp"), "/", base)

	cfg := &pb.GatewayConfig{
		// The compose carries the sentinel where the agent's real gw dir must go.
		ComposeYaml:      "services:\n  gw:\n    volumes:\n      - " + gatewayHostDirSentinel + ":/data/ssh-gateway\n",
		SshdConfig:       "Port 2222\n",
		WrapperScript:    "#!/bin/sh\nexec true\n",
		EntrypointScript: "#!/bin/sh\nexec sshd\n",
		SocketFilterCfg:  "frontend x\n",
	}
	if err := s.writeGatewayFiles(cfg); err != nil {
		t.Fatalf("writeGatewayFiles: %v", err)
	}

	gw := s.gwDir()
	// The sentinel is replaced with the agent's OWN gateway dir (a remote agent's
	// real host path, which the control plane cannot know).
	compose, err := os.ReadFile(filepath.Join(gw, "docker-compose.yml"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(compose), gatewayHostDirSentinel) {
		t.Error("sentinel was not substituted in the compose bind path")
	}
	if !strings.Contains(string(compose), gw+":/data/ssh-gateway") {
		t.Errorf("compose bind path was not set to the agent's gw dir; got:\n%s", compose)
	}

	// The wrapper + entrypoint are executable (0755); the others 0644.
	for name, want := range map[string]os.FileMode{
		"deplo-dev-shell":    0o755,
		"gateway-entrypoint": 0o755,
		"sshd_config":        0o644,
		"socket-filter.cfg":  0o644,
	} {
		st, err := os.Stat(filepath.Join(gw, name))
		if err != nil {
			t.Fatalf("stat %s: %v", name, err)
		}
		if st.Mode().Perm() != want {
			t.Errorf("%s mode = %o, want %o", name, st.Mode().Perm(), want)
		}
	}

	// The keys + map dirs are created (the gateway projection lands there).
	for _, d := range []string{"keys", "map"} {
		if st, err := os.Stat(filepath.Join(gw, d)); err != nil || !st.IsDir() {
			t.Errorf("expected gateway dir %q to exist: %v", d, err)
		}
	}
}

func TestWriteGatewayFilesRejectsEmptyConfig(t *testing.T) {
	base := t.TempDir()
	s := New(filepath.Join(base, "stacks"), filepath.Join(base, "tmp"), "/", base)
	// A config missing a required file is rejected (never write a half-gateway).
	cfg := &pb.GatewayConfig{ComposeYaml: "x", SshdConfig: "y"}
	if err := s.writeGatewayFiles(cfg); err == nil {
		t.Fatal("an incomplete gateway config must be rejected")
	}
}

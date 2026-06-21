package server

import (
	"archive/tar"
	"bytes"
	"os"
	"path/filepath"
	"testing"

	pb "github.com/idradev/deplo/agent/gen"
)

// nopEmitter discards every event — the tests assert on filesystem effects, not
// the emitted log lines.
func nopEmitter() *emitter {
	return &emitter{send: func(*pb.DeployEvent) error { return nil }}
}

// devModeService builds a Service whose dataBase/stackDir/buildTmp all live under
// a single temp dir, so the dev workspace + build dir resolve to real paths.
func devModeService(t *testing.T) *Service {
	t.Helper()
	base := t.TempDir()
	return New(filepath.Join(base, "stacks"), filepath.Join(base, "tmp"), "/", base)
}

func TestWorkspaceHasSource(t *testing.T) {
	s := devModeService(t)
	ws := s.workspaceDir("app")
	if err := os.MkdirAll(ws, 0o755); err != nil {
		t.Fatal(err)
	}
	if s.workspaceHasSource("app") {
		t.Fatal("empty workspace should have no source")
	}
	// Only excluded entries => still no source (mirrors WORKSPACE_BUILD_EXCLUDE).
	for _, e := range []string{"node_modules", ".deplo", ".deplo-home", ".git"} {
		if err := os.MkdirAll(filepath.Join(ws, e), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if s.workspaceHasSource("app") {
		t.Fatal("workspace of only-excluded entries should read as no source")
	}
	// A real file => source present.
	if err := os.WriteFile(filepath.Join(ws, "index.js"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !s.workspaceHasSource("app") {
		t.Fatal("workspace with a source file should read as having source")
	}
}

func TestMaterializeDevWorkspaceExcludesAndCopies(t *testing.T) {
	s := devModeService(t)
	if err := os.MkdirAll(s.buildTmpDir, 0o755); err != nil {
		t.Fatal(err)
	}
	ws := s.workspaceDir("app")
	mustWrite(t, filepath.Join(ws, "index.js"), "console.log(1)")
	mustWrite(t, filepath.Join(ws, "src/app.ts"), "export const x = 1")
	// Excluded entries must NOT be copied into the build dir.
	mustWrite(t, filepath.Join(ws, "node_modules/dep/index.js"), "dep")
	mustWrite(t, filepath.Join(ws, ".git/config"), "[core]")
	mustWrite(t, filepath.Join(ws, ".deplo/tunnel.log"), "log")

	e := nopEmitter()
	dir, cleanup, err := s.materializeDevWorkspace("app", "", e)
	if err != nil {
		t.Fatalf("materialize: %v", err)
	}
	defer cleanup()

	if _, err := os.Stat(filepath.Join(dir, "index.js")); err != nil {
		t.Errorf("index.js should be copied: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "src/app.ts")); err != nil {
		t.Errorf("src/app.ts should be copied: %v", err)
	}
	for _, ex := range []string{"node_modules", ".git", ".deplo"} {
		if _, err := os.Stat(filepath.Join(dir, ex)); !os.IsNotExist(err) {
			t.Errorf("%s must be excluded from the build context (err=%v)", ex, err)
		}
	}
}

func TestMaterializeDevWorkspaceSubdir(t *testing.T) {
	s := devModeService(t)
	if err := os.MkdirAll(s.buildTmpDir, 0o755); err != nil {
		t.Fatal(err)
	}
	ws := s.workspaceDir("app")
	mustWrite(t, filepath.Join(ws, "packages/web/index.js"), "web")
	mustWrite(t, filepath.Join(ws, "README.md"), "root")
	e := nopEmitter()
	// A rootDirectory subdir builds from that subtree.
	dir, cleanup, err := s.materializeDevWorkspace("app", "packages/web", e)
	if err != nil {
		t.Fatalf("materialize subdir: %v", err)
	}
	defer cleanup()
	if _, err := os.Stat(filepath.Join(dir, "index.js")); err != nil {
		t.Errorf("subdir build dir should contain index.js: %v", err)
	}
	// An escaping subdir is rejected.
	_, c2, err := s.materializeDevWorkspace("app", "../../etc", e)
	c2()
	if err == nil {
		t.Error("an escaping subdir must be rejected")
	}
	// A missing subdir errors clearly.
	_, c3, err := s.materializeDevWorkspace("app", "nope", e)
	c3()
	if err == nil {
		t.Error("a missing subdir must error")
	}
}

func TestMaterializeDevWorkspaceRejectsSymlink(t *testing.T) {
	s := devModeService(t)
	if err := os.MkdirAll(s.buildTmpDir, 0o755); err != nil {
		t.Fatal(err)
	}
	ws := s.workspaceDir("app")
	mustWrite(t, filepath.Join(ws, "index.js"), "ok")
	// A planted symlink to a host secret — must be rejected (not followed/preserved).
	if err := os.Symlink("/etc/passwd", filepath.Join(ws, "leak")); err != nil {
		t.Skipf("symlink unsupported: %v", err)
	}
	e := nopEmitter()
	_, cleanup, err := s.materializeDevWorkspace("app", "", e)
	cleanup()
	if err == nil {
		t.Fatal("a symlink in the dev workspace must reject the build context")
	}
}

func TestMaterializeDevWorkspaceErrors(t *testing.T) {
	s := devModeService(t)
	if err := os.MkdirAll(s.buildTmpDir, 0o755); err != nil {
		t.Fatal(err)
	}
	e := nopEmitter()
	// Missing workspace.
	if _, _, err := s.materializeDevWorkspace("nope", "", e); err == nil {
		t.Error("missing workspace should error")
	}
	// Workspace with only excluded entries => "nothing to deploy".
	ws := s.workspaceDir("empty")
	if err := os.MkdirAll(filepath.Join(ws, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.materializeDevWorkspace("empty", "", e); err == nil {
		t.Error("source-less workspace should error")
	}
}

func TestSeedUploadWorkspace(t *testing.T) {
	s := devModeService(t)
	tarBytes := buildTar(t, map[string]string{
		"index.js":     "main",
		"src/app.ts":   "app",
		"node_modules": "", // a dir entry that must be skipped (excluded mountpoint)
	})
	e := nopEmitter()
	if err := s.seedUploadWorkspace("app", tarBytes, e); err != nil {
		t.Fatalf("seed: %v", err)
	}
	ws := s.workspaceDir("app")
	if b, err := os.ReadFile(filepath.Join(ws, "index.js")); err != nil || string(b) != "main" {
		t.Errorf("index.js not seeded: %v %q", err, b)
	}
	// A second seed is a no-op (clone-once — never clobbers edits).
	mustWrite(t, filepath.Join(ws, "index.js"), "EDITED")
	if err := s.seedUploadWorkspace("app", tarBytes, e); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(ws, "index.js")); string(b) != "EDITED" {
		t.Error("re-seed must not clobber the user's edits")
	}
}

func TestSeedUploadWorkspaceConfinesTraversal(t *testing.T) {
	s := devModeService(t)
	// A `..`-laden entry is ANCHORED (Clean("/"+name) strips the leading `..`),
	// so it lands CONFINED inside the workspace — never above it. Same defence as
	// materializeUpload. The host path the entry tried to escape to must NOT exist.
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	body := []byte("pwn")
	_ = tw.WriteHeader(&tar.Header{Name: "../../etc/evil", Mode: 0o644, Size: int64(len(body)), Typeflag: tar.TypeReg})
	_, _ = tw.Write(body)
	_ = tw.Close()
	e := nopEmitter()
	if err := s.seedUploadWorkspace("app", buf.Bytes(), e); err != nil {
		t.Fatalf("anchored entry should be confined, not error: %v", err)
	}
	ws := s.workspaceDir("app")
	// Confined: written under the workspace, not at a sibling of dataBase.
	if _, err := os.Stat(filepath.Join(ws, "etc/evil")); err != nil {
		t.Errorf("escaping entry should be confined inside the workspace: %v", err)
	}
	if _, err := os.Stat(filepath.Join(s.dataBase, "..", "etc", "evil")); err == nil {
		t.Error("entry escaped the workspace — anti-traversal failed")
	}
}

func TestSeedUploadWorkspaceRejectsSymlink(t *testing.T) {
	s := devModeService(t)
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	_ = tw.WriteHeader(&tar.Header{Name: "leak", Linkname: "/etc/passwd", Typeflag: tar.TypeSymlink})
	_ = tw.Close()
	e := nopEmitter()
	if err := s.seedUploadWorkspace("app", buf.Bytes(), e); err == nil {
		t.Fatal("a symlink tar entry must be rejected")
	}
}

func mustWrite(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// buildTar packs files (key=path, value=content) into a tar; an empty value makes
// a directory entry.
func buildTar(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for name, body := range files {
		if body == "" {
			if err := tw.WriteHeader(&tar.Header{Name: name + "/", Mode: 0o755, Typeflag: tar.TypeDir}); err != nil {
				t.Fatal(err)
			}
			continue
		}
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(body)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

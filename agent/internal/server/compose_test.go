package server

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	pb "github.com/idradev/deplo/agent/gen"
)

// collectEmitter captures the events the deploy steps emit, so a test can assert
// what was logged without a real gRPC stream.
func collectEmitter() (*emitter, *[]*pb.DeployEvent) {
	var events []*pb.DeployEvent
	e := &emitter{send: func(ev *pb.DeployEvent) error {
		events = append(events, ev)
		return nil
	}}
	return e, &events
}

func TestRenderEnvFile_sortedKeyValueLines(t *testing.T) {
	got := renderEnvFile(map[string]string{"B": "2", "A": "1", "C": "3"})
	// Keys are sorted for a deterministic file; one KEY=VALUE per line.
	want := "A=1\nB=2\nC=3\n"
	if got != want {
		t.Fatalf("renderEnvFile = %q, want %q", got, want)
	}
}

func TestRenderEnvFile_collapsesNewlinesInValues(t *testing.T) {
	// A newline in a value would break the env-file format, so it collapses to a
	// space — matching the control plane's renderEnvFile (build.ts).
	got := renderEnvFile(map[string]string{"KEY": "line1\nline2", "WIN": "a\r\nb"})
	if strings.Contains(got, "\nline2") || strings.Contains(got, "a\r\nb") {
		t.Fatalf("newline not collapsed: %q", got)
	}
	if got != "KEY=line1 line2\nWIN=a b\n" {
		t.Fatalf("renderEnvFile = %q", got)
	}
}

func TestRenderEnvFile_empty(t *testing.T) {
	if got := renderEnvFile(map[string]string{}); got != "" {
		t.Fatalf("expected empty string, got %q", got)
	}
}

func TestWriteMountFiles_writesUnderFilesDir(t *testing.T) {
	stackDir := t.TempDir()
	s := New(stackDir, t.TempDir(), "/", "")
	e, _ := collectEmitter()

	mounts := []*pb.MountFile{
		{Path: "config.yml", Content: "a: 1"},
		{Path: "nested/app.conf", Content: "key=val"},
		{Path: "./prefixed.txt", Content: "ok"}, // leading ./ stripped
	}
	if err := s.writeMountFiles("myapp", mounts, e); err != nil {
		t.Fatalf("writeMountFiles: %v", err)
	}

	base := filepath.Join(stackDir, "files", "myapp")
	for path, want := range map[string]string{
		"config.yml":      "a: 1",
		"nested/app.conf": "key=val",
		"prefixed.txt":    "ok",
	} {
		got, err := os.ReadFile(filepath.Join(base, path))
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		if string(got) != want {
			t.Fatalf("%s = %q, want %q", path, got, want)
		}
	}
}

func TestWriteMountFiles_rejectsEscape(t *testing.T) {
	stackDir := t.TempDir()
	s := New(stackDir, t.TempDir(), "/", "")
	e, events := collectEmitter()

	mounts := []*pb.MountFile{
		{Path: "../escape.txt", Content: "pwned"},
		{Path: "sub/../../escape2.txt", Content: "pwned"},
	}
	if err := s.writeMountFiles("myapp", mounts, e); err != nil {
		t.Fatalf("writeMountFiles should skip, not error: %v", err)
	}

	// Nothing escaped the project files dir's PARENT (stackDir/files).
	filesRoot := filepath.Join(stackDir, "files")
	if _, err := os.Stat(filepath.Join(filesRoot, "escape.txt")); err == nil {
		t.Fatal("escape.txt was written outside the project files dir")
	}
	if _, err := os.Stat(filepath.Join(stackDir, "escape2.txt")); err == nil {
		t.Fatal("escape2.txt escaped the files dir")
	}
	// Each unsafe path is surfaced as a warn log, not silently dropped.
	warns := 0
	for _, ev := range *events {
		if l := ev.GetLog(); l != nil && l.GetLevel() == "warn" {
			warns++
		}
	}
	if warns != len(mounts) {
		t.Fatalf("expected %d warn logs, got %d", len(mounts), warns)
	}
}

func TestWriteMountFiles_noMountsIsNoop(t *testing.T) {
	stackDir := t.TempDir()
	s := New(stackDir, t.TempDir(), "/", "")
	e, _ := collectEmitter()
	if err := s.writeMountFiles("myapp", nil, e); err != nil {
		t.Fatalf("writeMountFiles(nil): %v", err)
	}
	// No files dir is created when there is nothing to write.
	if _, err := os.Stat(filepath.Join(stackDir, "files", "myapp")); err == nil {
		t.Fatal("files dir created for an empty mount list")
	}
}

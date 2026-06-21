package server

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	pb "github.com/idradev/deplo/agent/gen"
)

// newFilesService builds a Service whose stackDir is a temp dir, with the files
// root for `slug` pre-created so reads/lists work.
func newFilesService(t *testing.T, slug string) (*Service, string) {
	t.Helper()
	stackDir := t.TempDir()
	s := New(stackDir, t.TempDir(), "/")
	root := filepath.Join(stackDir, "files", slug)
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	return s, root
}

func TestNormalizeRel(t *testing.T) {
	ok := map[string]string{
		"":     "",
		".":    "",
		"a":    "a",
		"a/b":  "a/b",
		"/a/b": "a/b",
		"a//b": "a/b",
		"a/b/": "a/b",
		`a\b`:  "a/b",
	}
	for in, want := range ok {
		got, err := normalizeRel(in)
		if err != nil || got != want {
			t.Errorf("normalizeRel(%q) = (%q,%v), want (%q,nil)", in, got, err, want)
		}
	}
	bad := []string{"..", "a/../b", "../escape", `a\..\b`, "sub/../../x"}
	for _, in := range bad {
		if _, err := normalizeRel(in); err == nil {
			t.Errorf("normalizeRel(%q) = nil error, want traversal rejection", in)
		}
	}
}

func TestFiles_WriteReadList(t *testing.T) {
	ctx := context.Background()
	s, _ := newFilesService(t, "app")

	if _, err := s.WriteFile(ctx, &pb.WriteFileRequest{Slug: "app", Path: "config/app.yml", Content: "key: value\n"}); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	rd, err := s.ReadFile(ctx, &pb.ReadFileRequest{Slug: "app", Path: "config/app.yml"})
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if rd.Text != "key: value\n" || rd.Reason != "" {
		t.Fatalf("ReadFile got text=%q reason=%q", rd.Text, rd.Reason)
	}
	ls, err := s.ListFiles(ctx, &pb.ListFilesRequest{Slug: "app", Path: ""})
	if err != nil {
		t.Fatalf("ListFiles: %v", err)
	}
	if len(ls.Entries) != 1 || ls.Entries[0].Name != "config" || ls.Entries[0].Kind != "dir" {
		t.Fatalf("ListFiles root = %#v, want one dir 'config'", ls.Entries)
	}
}

func TestFiles_BinaryDetection(t *testing.T) {
	ctx := context.Background()
	s, root := newFilesService(t, "app")
	// Plant a file with a NUL byte in the first chunk.
	if err := os.WriteFile(filepath.Join(root, "blob.bin"), []byte("abc\x00def"), 0o644); err != nil {
		t.Fatal(err)
	}
	rd, err := s.ReadFile(ctx, &pb.ReadFileRequest{Slug: "app", Path: "blob.bin"})
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if rd.Reason != "binary" || rd.Text != "" {
		t.Fatalf("binary file got reason=%q text=%q, want reason=binary", rd.Reason, rd.Text)
	}
}

func TestFiles_TooLarge(t *testing.T) {
	ctx := context.Background()
	s, root := newFilesService(t, "app")
	big := make([]byte, maxViewBytes+1)
	for i := range big {
		big[i] = 'a'
	}
	if err := os.WriteFile(filepath.Join(root, "big.txt"), big, 0o644); err != nil {
		t.Fatal(err)
	}
	rd, err := s.ReadFile(ctx, &pb.ReadFileRequest{Slug: "app", Path: "big.txt"})
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if rd.Reason != "too-large" || rd.Text != "" {
		t.Fatalf("oversized file got reason=%q, want too-large", rd.Reason)
	}
}

func TestFiles_WriteCapEnforced(t *testing.T) {
	ctx := context.Background()
	s, _ := newFilesService(t, "app")
	huge := strings.Repeat("x", maxWriteBytes+1)
	if _, err := s.WriteFile(ctx, &pb.WriteFileRequest{Slug: "app", Path: "x", Content: huge}); err == nil {
		t.Fatal("WriteFile oversized = nil error, want rejection")
	}
}

func TestFiles_RejectTraversal(t *testing.T) {
	ctx := context.Background()
	s, _ := newFilesService(t, "app")
	bad := []string{"../escape.txt", "sub/../../escape.txt", "..", `..\win.txt`}
	for _, p := range bad {
		if _, err := s.ReadFile(ctx, &pb.ReadFileRequest{Slug: "app", Path: p}); err == nil {
			t.Errorf("ReadFile(%q) = nil error, want traversal rejection", p)
		}
		if _, err := s.WriteFile(ctx, &pb.WriteFileRequest{Slug: "app", Path: p, Content: "x"}); err == nil {
			t.Errorf("WriteFile(%q) = nil error, want traversal rejection", p)
		}
	}
}

func TestFiles_RejectSymlinkEscape(t *testing.T) {
	ctx := context.Background()
	s, root := newFilesService(t, "app")
	// Plant a symlink inside the root pointing OUTSIDE it; reading through it must
	// be rejected (realpath lands outside the sandbox boundary).
	outside := t.TempDir()
	secret := filepath.Join(outside, "secret.txt")
	if err := os.WriteFile(secret, []byte("top secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Skip("symlinks unsupported on this platform")
	}
	if _, err := s.ReadFile(ctx, &pb.ReadFileRequest{Slug: "app", Path: "escape/secret.txt"}); err == nil {
		t.Fatal("ReadFile through escaping symlink = nil error, want rejection")
	}
}

func TestFiles_RefuseClobberDir(t *testing.T) {
	ctx := context.Background()
	s, _ := newFilesService(t, "app")
	if _, err := s.CreateDir(ctx, &pb.CreateDirRequest{Slug: "app", Path: "data"}); err != nil {
		t.Fatalf("CreateDir: %v", err)
	}
	if _, err := s.WriteFile(ctx, &pb.WriteFileRequest{Slug: "app", Path: "data", Content: "x"}); err == nil {
		t.Fatal("WriteFile over a directory = nil error, want refusal")
	}
}

func TestFiles_DeleteRefusesRoot(t *testing.T) {
	ctx := context.Background()
	s, _ := newFilesService(t, "app")
	if _, err := s.DeleteFile(ctx, &pb.DeleteFileRequest{Slug: "app", Path: ""}); err == nil {
		t.Fatal("DeleteFile(root) = nil error, want refusal")
	}
	if _, err := s.DeleteFile(ctx, &pb.DeleteFileRequest{Slug: "app", Path: "."}); err == nil {
		t.Fatal("DeleteFile(.) = nil error, want refusal")
	}
}

func TestFiles_RenameContainment(t *testing.T) {
	ctx := context.Background()
	s, _ := newFilesService(t, "app")
	if _, err := s.WriteFile(ctx, &pb.WriteFileRequest{Slug: "app", Path: "a.txt", Content: "hi"}); err != nil {
		t.Fatal(err)
	}
	// Valid in-root rename.
	if _, err := s.RenameFile(ctx, &pb.RenameFileRequest{Slug: "app", Path: "a.txt", NewPath: "sub/b.txt"}); err != nil {
		t.Fatalf("RenameFile in-root: %v", err)
	}
	// Destination escaping the root must be rejected.
	if _, err := s.RenameFile(ctx, &pb.RenameFileRequest{Slug: "app", Path: "sub/b.txt", NewPath: "../escape.txt"}); err == nil {
		t.Fatal("RenameFile to escaping dest = nil error, want rejection")
	}
}

func TestFiles_Exist(t *testing.T) {
	ctx := context.Background()
	s, _ := newFilesService(t, "app")
	ex, err := s.FilesExist(ctx, &pb.FilesExistRequest{Slug: "app"})
	if err != nil || !ex.Exists {
		t.Fatalf("FilesExist(app) = (%v,%v), want exists=true", ex, err)
	}
	none, err := s.FilesExist(ctx, &pb.FilesExistRequest{Slug: "nope"})
	if err != nil || none.Exists {
		t.Fatalf("FilesExist(nope) = (%v,%v), want exists=false", none, err)
	}
}

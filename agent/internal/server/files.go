package server

import (
	"bytes"
	"context"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "github.com/idradev/deplo/agent/gen"
	"github.com/idradev/deplo/agent/internal/safepath"
)

// files.go ports lib/data/project-files.ts to the agent: browse/edit a project's
// <stack-dir>/files/<slug> tree, the on-disk backing for the "./" project-files
// volume convention. The anti-traversal sandbox is RE-ENFORCED here (not trusted
// from the control plane) because the path arrives off the wire — PLAN D9. The
// root is derived agent-side from the slug; a root path is never taken off the
// wire.

const (
	// Files larger than this are never streamed to the editor as text.
	maxViewBytes = 512 * 1024 // 512 KiB
	// Reject writes whose body exceeds this — the editor is for config, not blobs.
	maxWriteBytes = 1024 * 1024 // 1 MiB
)

// slugPattern is the shape a Deplo project slug always has (the control plane
// sanitises to [a-z0-9-] at creation). The `slug` arrives off the wire and is
// JOINED INTO the files root, so — exactly like the relative `path` — it must be
// validated where the I/O runs and never trusted: a slug like "../../etc" would
// otherwise escape <stack-dir>/files entirely. Defence in depth behind the
// control plane's own sanitisation.
var slugPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)

func validateSlug(slug string) error {
	if !slugPattern.MatchString(slug) {
		return status.Errorf(codes.InvalidArgument, "invalid slug %q", slug)
	}
	return nil
}

// filesRoot is the host path of a project's files root. The agent's --stack-dir
// is the equivalent of the control plane's /data/stacks, so files/<slug> mirrors
// lib/data/project-files.ts filesRoot exactly. The caller MUST validateSlug first.
func (s *Service) filesRoot(slug string) string {
	return filepath.Join(s.stackDir, "files", slug)
}

// normalizeRel mirrors lib/data/project-files.ts normalizeRel: clean a relative
// path to POSIX form, reject absolute paths and any ".." segment up front.
func normalizeRel(rel string) (string, error) {
	r := strings.ReplaceAll(rel, "\\", "/")
	r = strings.TrimLeft(r, "/")
	r = strings.TrimRight(r, "/")
	for strings.Contains(r, "//") {
		r = strings.ReplaceAll(r, "//", "/")
	}
	if r == "" || r == "." {
		return "", nil
	}
	for _, seg := range strings.Split(r, "/") {
		if seg == ".." {
			return "", status.Error(codes.InvalidArgument, "path traversal is not allowed")
		}
	}
	return r, nil
}

// resolveInside resolves a (user-supplied) relative path to an absolute host path
// PROVABLY inside `root`, with symlinks resolved — mirroring resolveWithinRoot.
//
// Two layered guards, matching the TS: (1) normalizeRel already rejected any ".."
// segment lexically, so the joined path can't escape by traversal; (2) the
// realpath check defeats a PLANTED SYMLINK among the path's existing components.
// Because the leaf may not exist yet (a new file/folder), we canonicalise the
// nearest EXISTING ancestor with safepath.Inside (which returns root on an escape,
// detected by comparing to the canonical root) and re-append the not-yet-created
// tail lexically.
func resolveInside(root, rel string) (string, error) {
	norm, err := normalizeRel(rel)
	if err != nil {
		return "", err
	}
	if norm == "" {
		return canonicalRoot(root), nil
	}
	// Walk up to the nearest existing ancestor and realpath-check IT against root.
	existing := norm
	var tail []string
	for {
		cand := filepath.Join(root, existing)
		if _, statErr := os.Lstat(cand); statErr == nil {
			break // `existing` exists; canonicalise it
		}
		parent := path.Dir(existing)
		tail = append([]string{path.Base(existing)}, tail...)
		if parent == "." {
			existing = "" // nothing in the path exists yet; anchor at root
			break
		}
		existing = parent
	}
	base := canonicalRoot(root)
	if existing != "" {
		abs, _ := safepath.Inside(root, filepath.Join(root, existing))
		if abs == canonicalRoot(root) && existing != "" {
			// The existing ancestor canonicalises to root despite a non-empty path
			// => a symlink among its components escaped the sandbox.
			return "", status.Error(codes.InvalidArgument, "path escapes the project files directory")
		}
		base = abs
	}
	if len(tail) > 0 {
		return filepath.Join(append([]string{base}, tail...)...), nil
	}
	return base, nil
}

// resolveParentInside mirrors resolveParentInsideRoot: for a target that may not
// exist yet (a new file/folder), the LEAF need not exist but its PARENT must
// resolve inside the root. Returns the absolute (non-canonical) leaf path + the
// normalised relative path.
func resolveParentInside(root, rel string) (abs, norm string, err error) {
	norm, err = normalizeRel(rel)
	if err != nil {
		return "", "", err
	}
	if norm == "" {
		return "", "", status.Error(codes.InvalidArgument, "a path is required")
	}
	parentRel := path.Dir(norm)
	if parentRel == "." {
		parentRel = ""
	}
	realParent, err := resolveInside(root, parentRel)
	if err != nil {
		return "", "", err
	}
	return filepath.Join(realParent, path.Base(norm)), norm, nil
}

// canonicalRoot is the realpath of the root (or its lexical clean form if it
// can't be resolved), matching how safepath.Inside computes realBase.
func canonicalRoot(root string) string {
	if r, err := filepath.EvalSymlinks(root); err == nil {
		return r
	}
	return filepath.Clean(root)
}

func (s *Service) FilesExist(ctx context.Context, req *pb.FilesExistRequest) (*pb.FilesExistResponse, error) {
	if err := validateSlug(req.GetSlug()); err != nil {
		return nil, err
	}
	st, err := os.Stat(s.filesRoot(req.GetSlug()))
	exists := err == nil && st.IsDir()
	return &pb.FilesExistResponse{Exists: exists}, nil
}

func (s *Service) ListFiles(ctx context.Context, req *pb.ListFilesRequest) (*pb.ListFilesResponse, error) {
	if err := validateSlug(req.GetSlug()); err != nil {
		return nil, err
	}
	root := s.filesRoot(req.GetSlug())
	abs, err := resolveInside(root, req.GetPath())
	if err != nil {
		return nil, err
	}
	rel, _ := normalizeRel(req.GetPath())
	dirents, err := os.ReadDir(abs)
	if err != nil {
		return nil, status.Errorf(codes.NotFound, "list %s: %v", rel, err)
	}
	entries := make([]*pb.FileEntry, 0, len(dirents))
	for _, d := range dirents {
		// Resolve through symlinks with Stat; skip anything that isn't a plain
		// dir/file or whose target vanished between ReadDir and Stat.
		info, err := os.Stat(filepath.Join(abs, d.Name()))
		if err != nil {
			continue
		}
		kind := ""
		if info.IsDir() {
			kind = "dir"
		} else if info.Mode().IsRegular() {
			kind = "file"
		} else {
			continue
		}
		entryPath := d.Name()
		if rel != "" {
			entryPath = rel + "/" + d.Name()
		}
		size := int64(0)
		if kind == "file" {
			size = info.Size()
		}
		entries = append(entries, &pb.FileEntry{
			Path:       entryPath,
			Name:       d.Name(),
			Kind:       kind,
			Size:       size,
			ModifiedAt: info.ModTime().UTC().Format(time.RFC3339Nano),
		})
	}
	// Directories first, then files, each alphabetical.
	sort.SliceStable(entries, func(i, j int) bool {
		a, b := entries[i], entries[j]
		if a.Kind != b.Kind {
			return a.Kind == "dir"
		}
		return a.Name < b.Name
	})
	return &pb.ListFilesResponse{Entries: entries}, nil
}

func (s *Service) ReadFile(ctx context.Context, req *pb.ReadFileRequest) (*pb.ReadFileResponse, error) {
	if err := validateSlug(req.GetSlug()); err != nil {
		return nil, err
	}
	root := s.filesRoot(req.GetSlug())
	abs, err := resolveInside(root, req.GetPath())
	if err != nil {
		return nil, err
	}
	rel, _ := normalizeRel(req.GetPath())
	st, err := os.Stat(abs)
	if err != nil {
		return nil, status.Errorf(codes.NotFound, "read %s: %v", rel, err)
	}
	if !st.Mode().IsRegular() {
		return nil, status.Error(codes.InvalidArgument, "not a file")
	}
	if st.Size() > maxViewBytes {
		return &pb.ReadFileResponse{Path: rel, Size: st.Size(), Reason: "too-large"}, nil
	}
	buf, err := os.ReadFile(abs)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "read %s: %v", rel, err)
	}
	// A NUL byte in the first chunk is a reliable binary tell for config trees.
	probe := buf
	if len(probe) > 8000 {
		probe = probe[:8000]
	}
	if bytes.IndexByte(probe, 0) >= 0 {
		return &pb.ReadFileResponse{Path: rel, Size: st.Size(), Reason: "binary"}, nil
	}
	return &pb.ReadFileResponse{Path: rel, Text: string(buf), Size: st.Size(), Reason: ""}, nil
}

func (s *Service) WriteFile(ctx context.Context, req *pb.WriteFileRequest) (*pb.FileEntryResult, error) {
	if len(req.GetContent()) > maxWriteBytes {
		return nil, status.Error(codes.InvalidArgument, "file is too large to save (1 MiB max)")
	}
	return s.writeBytes(req.GetSlug(), req.GetPath(), []byte(req.GetContent()))
}

func (s *Service) UploadFile(ctx context.Context, req *pb.UploadFileRequest) (*pb.FileEntryResult, error) {
	if len(req.GetData()) > maxWriteBytes {
		return nil, status.Error(codes.InvalidArgument, "file is too large to upload (1 MiB max)")
	}
	return s.writeBytes(req.GetSlug(), req.GetPath(), req.GetData())
}

// writeBytes is the shared body of WriteFile/UploadFile: create parent dirs,
// refuse to clobber a directory, write 0644, return fresh metadata.
func (s *Service) writeBytes(slug, p string, data []byte) (*pb.FileEntryResult, error) {
	if err := validateSlug(slug); err != nil {
		return nil, err
	}
	root := s.filesRoot(slug)
	abs, rel, err := resolveParentInside(root, p)
	if err != nil {
		return nil, err
	}
	if st, e := os.Stat(abs); e == nil && st.IsDir() {
		return nil, status.Error(codes.InvalidArgument, "a folder already exists there")
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return nil, status.Errorf(codes.Internal, "mkdir: %v", err)
	}
	// 0644 — bind-mounted into the app container, which may run as non-root.
	if err := os.WriteFile(abs, data, 0o644); err != nil {
		return nil, status.Errorf(codes.Internal, "write %s: %v", rel, err)
	}
	return s.entryResult(abs, rel)
}

func (s *Service) CreateDir(ctx context.Context, req *pb.CreateDirRequest) (*pb.FileEntryResult, error) {
	if err := validateSlug(req.GetSlug()); err != nil {
		return nil, err
	}
	root := s.filesRoot(req.GetSlug())
	abs, rel, err := resolveParentInside(root, req.GetPath())
	if err != nil {
		return nil, err
	}
	if _, e := os.Stat(abs); e == nil {
		return nil, status.Error(codes.AlreadyExists, "that path already exists")
	}
	if err := os.MkdirAll(abs, 0o755); err != nil {
		return nil, status.Errorf(codes.Internal, "mkdir %s: %v", rel, err)
	}
	return s.entryResult(abs, rel)
}

func (s *Service) DeleteFile(ctx context.Context, req *pb.DeleteFileRequest) (*pb.DeleteFileResult, error) {
	if err := validateSlug(req.GetSlug()); err != nil {
		return nil, err
	}
	root := s.filesRoot(req.GetSlug())
	abs, err := resolveInside(root, req.GetPath())
	if err != nil {
		return nil, err
	}
	if abs == canonicalRoot(root) {
		return nil, status.Error(codes.InvalidArgument, "cannot delete the project files root")
	}
	if err := os.RemoveAll(abs); err != nil {
		return nil, status.Errorf(codes.Internal, "delete: %v", err)
	}
	return &pb.DeleteFileResult{Ok: true}, nil
}

func (s *Service) RenameFile(ctx context.Context, req *pb.RenameFileRequest) (*pb.FileEntryResult, error) {
	if err := validateSlug(req.GetSlug()); err != nil {
		return nil, err
	}
	root := s.filesRoot(req.GetSlug())
	from, err := resolveInside(root, req.GetPath())
	if err != nil {
		return nil, err
	}
	if from == canonicalRoot(root) {
		return nil, status.Error(codes.InvalidArgument, "cannot move the project files root")
	}
	to, rel, err := resolveParentInside(root, req.GetNewPath())
	if err != nil {
		return nil, err
	}
	if _, e := os.Stat(to); e == nil {
		return nil, status.Error(codes.AlreadyExists, "the destination already exists")
	}
	if err := os.MkdirAll(filepath.Dir(to), 0o755); err != nil {
		return nil, status.Errorf(codes.Internal, "mkdir: %v", err)
	}
	if err := os.Rename(from, to); err != nil {
		return nil, status.Errorf(codes.Internal, "rename: %v", err)
	}
	return s.entryResult(to, rel)
}

// entryResult stats `abs` and packs a FileEntry (rel is the in-root path).
func (s *Service) entryResult(abs, rel string) (*pb.FileEntryResult, error) {
	st, err := os.Stat(abs)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "stat: %v", err)
	}
	kind := "file"
	size := st.Size()
	if st.IsDir() {
		kind = "dir"
		size = 0
	}
	return &pb.FileEntryResult{Entry: &pb.FileEntry{
		Path:       rel,
		Name:       path.Base(rel),
		Kind:       kind,
		Size:       size,
		ModifiedAt: st.ModTime().UTC().Format(time.RFC3339Nano),
	}}, nil
}

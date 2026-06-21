// Package safepath re-ports the control plane's path-containment guard
// (lib/deploy/path-safety.ts safeBuildDir) to Go. Path validation must run where
// the I/O runs and must never trust a path that arrived off the wire (PLAN D9):
// a Dockerfile/context path in a DeployRequest, or (Part C) a file RPC path, is
// resolved against the build/files root and confirmed to stay inside it via
// realpath — defeating symlink escapes a string-prefix check would miss.
package safepath

import (
	"os"
	"path/filepath"
	"strings"
)

// Inside canonicalises `candidate` (a path formed by joining an off-the-wire,
// user-controlled relative segment onto a trusted `base`) and returns it only
// if it is `base` itself or a real descendant. On any escape, missing target,
// or error it returns the canonical `base` — so a caller can detect a fallback
// by comparing the result to Inside(base, ".") (a typo'd path resolves to root).
// A path-separator boundary stops a sibling like `<base>-evil` from matching.
func Inside(base, candidate string) (string, error) {
	realBase, err := filepath.EvalSymlinks(base)
	if err != nil {
		// base is always a dir we created; if it can't be resolved, fall back
		// to its lexical clean form rather than failing the whole deploy.
		realBase = filepath.Clean(base)
	}
	realCandidate, err := filepath.EvalSymlinks(candidate)
	if err != nil {
		return realBase, nil
	}
	if realCandidate == realBase || strings.HasPrefix(realCandidate, realBase+string(os.PathSeparator)) {
		return realCandidate, nil
	}
	return realBase, nil
}

// Join cleans a user-supplied relative path and joins it under base WITHOUT
// touching the filesystem, rejecting absolute paths and any ".." segment. Used
// to resolve a Dockerfile/context path before the target necessarily exists
// (the file may be created by the build). The lexical guard here is backed by
// the realpath guard in Inside once the parent exists.
func Join(base, rel string) (string, bool) {
	rel = strings.ReplaceAll(rel, "\\", "/")
	rel = strings.TrimPrefix(rel, "./")
	rel = strings.TrimPrefix(rel, "/")
	if rel == "" || rel == "." {
		return base, true
	}
	for _, seg := range strings.Split(rel, "/") {
		if seg == ".." {
			return base, false
		}
	}
	return filepath.Join(base, rel), true
}

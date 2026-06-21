package safepath

import (
	"os"
	"path/filepath"
	"testing"
)

func TestJoin_rejectsEscapes(t *testing.T) {
	base := "/build/ctx"
	cases := []struct {
		rel  string
		ok   bool
		want string
	}{
		{".", true, base},
		{"", true, base},
		{"Dockerfile", true, filepath.Join(base, "Dockerfile")},
		{"./sub/Dockerfile", true, filepath.Join(base, "sub/Dockerfile")},
		{"../escape", false, base},
		{"sub/../../escape", false, base},
		{"/abs/path", true, filepath.Join(base, "abs/path")}, // leading / stripped, contained
	}
	for _, c := range cases {
		got, ok := Join(base, c.rel)
		if ok != c.ok || got != c.want {
			t.Errorf("Join(%q,%q) = (%q,%v), want (%q,%v)", base, c.rel, got, ok, c.want, c.ok)
		}
	}
}

func TestInside_followsRealpathAndContains(t *testing.T) {
	root := t.TempDir()
	sub := filepath.Join(root, "sub")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	got, err := Inside(root, sub)
	if err != nil || got != mustEval(t, sub) {
		t.Fatalf("Inside(root, sub) = (%q,%v), want %q", got, err, mustEval(t, sub))
	}

	// A symlink pointing OUTSIDE root must fall back to root (escape defeated).
	outside := t.TempDir()
	link := filepath.Join(root, "link")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	got, _ = Inside(root, link)
	if got != mustEval(t, root) {
		t.Fatalf("symlink escape not contained: got %q, want %q", got, mustEval(t, root))
	}
}

func mustEval(t *testing.T, p string) string {
	t.Helper()
	r, err := filepath.EvalSymlinks(p)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

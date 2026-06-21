package server

import (
	"strings"
	"testing"
)

func TestAuthenticatedURL_injectsToken(t *testing.T) {
	clone, display := authenticatedURL("https://github.com/acme/app.git", "tok-secret")
	if !strings.Contains(clone, "x-access-token:tok-secret@") {
		t.Fatalf("token not injected: %s", clone)
	}
	if strings.Contains(display, "tok-secret") {
		t.Fatalf("display URL leaks the token: %s", display)
	}
}

func TestAuthenticatedURL_keepsPreAuthenticated(t *testing.T) {
	// A control-plane GitHub-App URL arrives already authenticated; don't double it.
	pre := "https://x-access-token:ghs_existing@github.com/acme/app.git"
	clone, display := authenticatedURL(pre, "ignored")
	if clone != pre {
		t.Fatalf("pre-authenticated URL was modified: %s", clone)
	}
	if strings.Contains(display, "ghs_existing") {
		t.Fatalf("display URL leaks the existing token: %s", display)
	}
}

func TestAuthenticatedURL_publicNoToken(t *testing.T) {
	clone, display := authenticatedURL("https://github.com/acme/public.git", "")
	if strings.Contains(clone, "@") {
		t.Fatalf("public URL gained credentials: %s", clone)
	}
	if display != "https://github.com/acme/public.git" {
		t.Fatalf("display mismatch: %s", display)
	}
}

func TestSanitizeGitLine_scrubsToken(t *testing.T) {
	line := "Cloning into https://x-access-token:supersecret@github.com/acme/app.git ..."
	got := sanitizeGitLine(line)
	if strings.Contains(got, "supersecret") {
		t.Fatalf("token survived sanitisation: %s", got)
	}
	if !strings.Contains(got, "x-access-token:***@") {
		t.Fatalf("expected masked token marker, got: %s", got)
	}
}

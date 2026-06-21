package server

import "testing"

func TestServiceOf(t *testing.T) {
	cases := []struct {
		slug, container, want string
	}{
		// Compose container: deplo-<slug>-<service>-N -> <service>.
		{"myapp", "deplo-myapp-web-1", "web"},
		{"myapp", "deplo-myapp-worker-2", "worker"},
		// Multi-word service with a replica index.
		{"myapp", "deplo-myapp-api-server-1", "api-server"},
		// Single-image deploy: the bare deplo-<slug> -> slug.
		{"myapp", "deplo-myapp", "myapp"},
		// A service whose name itself ends in a non-numeric segment.
		{"myapp", "deplo-myapp-db", "db"},
		// An unrelated container name (no deplo- prefix at all).
		{"myapp", "some-other", "some-other"},
	}
	for _, c := range cases {
		if got := serviceOf(c.slug, c.container); got != c.want {
			t.Errorf("serviceOf(%q,%q) = %q, want %q", c.slug, c.container, got, c.want)
		}
	}
}

func TestTrimTrailingReplicaIndex(t *testing.T) {
	cases := map[string]string{
		"web-1":        "web",
		"api-server-2": "api-server",
		"db":           "db",
		"web-":         "web-",    // trailing dash, no index
		"web-abc":      "web-abc", // non-numeric suffix
		"x-10":         "x",
	}
	for in, want := range cases {
		if got := trimTrailingReplicaIndex(in); got != want {
			t.Errorf("trimTrailingReplicaIndex(%q) = %q, want %q", in, got, want)
		}
	}
}

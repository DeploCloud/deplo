package server

import (
	"reflect"
	"testing"
)

func TestSplitArgv(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"", []string{}},
		{"ls", []string{"ls"}},
		{"ls -la /tmp", []string{"ls", "-la", "/tmp"}},
		{`echo "hello world"`, []string{"echo", "hello world"}},
		{`echo 'single quoted'`, []string{"echo", "single quoted"}},
		{`cat "a b" 'c d'`, []string{"cat", "a b", "c d"}},
		{"  spaced   out  ", []string{"spaced", "out"}},
		{"tab\tsep", []string{"tab", "sep"}},
		{`mix"ed"quotes`, []string{"mixedquotes"}},
	}
	for _, c := range cases {
		got := splitArgv(c.in)
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("splitArgv(%q) = %#v, want %#v", c.in, got, c.want)
		}
	}
}

func TestIsDockerLevelStderr(t *testing.T) {
	dockerLevel := []string{
		"Error response from daemon: No such container: deplo-foo",
		"OCI runtime exec failed: exec failed: unable to start container process: exec: \"sh\": executable file not found in $PATH",
		"Cannot connect to the Docker daemon at unix:///var/run/docker.sock.",
		"Error response from daemon: Container deplo-x is not running",
		"cannot exec in a stopped state",
	}
	for _, s := range dockerLevel {
		if !isDockerLevelStderr(s) {
			t.Errorf("isDockerLevelStderr(%q) = false, want true", s)
		}
	}

	// Guest command output must NOT be classified as a docker-level failure.
	guest := []string{
		"sh: gtrger: not found",
		"bash: command-not-here: command not found",
		"ls: cannot access '/nope': No such file or directory",
		"",
		"permission denied",
	}
	for _, s := range guest {
		if isDockerLevelStderr(s) {
			t.Errorf("isDockerLevelStderr(%q) = true, want false (guest output)", s)
		}
	}
}

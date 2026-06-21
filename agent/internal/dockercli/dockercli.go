// Package dockercli is the agent's Docker client: it shells out to the `docker`
// CLI against the host's daemon, exactly as the control plane's
// lib/infra/docker.ts does today. No DOCKER_HOST/tcp:// indirection — the agent
// runs ON the target host, so the local socket IS the right daemon. This is the
// host-coupled half of the platform moved server-side (ADR-0006).
//
// Every helper uses exec without a shell, so arguments are injection-safe.
package dockercli

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"time"
)

// LineFn receives one line of merged stdout+stderr as a build/run stream.
type LineFn func(line string)

// Run executes `docker <args>` to completion, returning combined output and the
// exit code. A nil error with a non-zero code means docker ran and the command
// failed; a non-nil error means docker itself could not run (spawn/timeout).
type Result struct {
	Stdout string
	Stderr string
	Code   int
}

// Run runs `docker <args>` with a timeout, capturing output. It returns an
// error only when the process never produced an exit status (spawn failure,
// timeout) — a non-zero exit is reported via Result.Code, mirroring the TS
// client's noThrow discipline so callers decide how to surface failures.
func Run(ctx context.Context, timeout time.Duration, args ...string) (Result, error) {
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(cctx, "docker", args...)
	var out, errb strings.Builder
	cmd.Stdout = &out
	cmd.Stderr = &errb
	err := cmd.Run()
	res := Result{Stdout: out.String(), Stderr: errb.String()}
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			res.Code = ee.ExitCode()
			return res, nil // ran, exited non-zero
		}
		// Spawn failure or timeout: docker never produced an exit status.
		return res, fmt.Errorf("docker %s failed: %w (%s)", strings.Join(args, " "), err, errb.String())
	}
	return res, nil
}

// Stream runs `docker <args>` and forwards each line of merged stdout+stderr to
// onLine as it is produced (the live build/clone log), returning the exit code.
// Mirrors lib/infra/exec.ts spawnStream. `input`, when non-empty, is written to
// the child's stdin and the stream is closed (e.g. a Dockerfile for `build -`).
func Stream(ctx context.Context, timeout time.Duration, onLine LineFn, input string, args ...string) (int, error) {
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(cctx, "docker", args...)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return -1, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return -1, err
	}
	if input != "" {
		stdin, err := cmd.StdinPipe()
		if err != nil {
			return -1, err
		}
		go func() {
			defer stdin.Close()
			io.WriteString(stdin, input)
		}()
	}

	if err := cmd.Start(); err != nil {
		return -1, fmt.Errorf("docker %s: %w", strings.Join(args, " "), err)
	}

	// Merge both streams line-by-line. A small fan-in over two scanners keeps
	// ordering close to emission order, same as the TS flush().
	done := make(chan struct{}, 2)
	scan := func(r io.Reader) {
		defer func() { done <- struct{}{} }()
		sc := bufio.NewScanner(r)
		sc.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
		for sc.Scan() {
			onLine(strings.TrimRight(sc.Text(), "\r"))
		}
	}
	go scan(stdout)
	go scan(stderr)
	<-done
	<-done

	err = cmd.Wait()
	if err != nil {
		// Check the context FIRST: when CommandContext kills the child on timeout
		// or cancellation, Wait() returns an *exec.ExitError with ExitCode()==-1
		// (SIGKILL, ProcessState.Exited()==false). Matching the ExitError branch
		// before this would misreport a real timeout as a generic "exit -1"
		// failure and leave this clear message unreachable.
		if cctx.Err() == context.DeadlineExceeded {
			return -1, fmt.Errorf("docker %s timed out after %s", strings.Join(args, " "), timeout)
		}
		if cctx.Err() == context.Canceled {
			return -1, fmt.Errorf("docker %s canceled", strings.Join(args, " "))
		}
		// A genuine non-zero exit: the process ran and failed (ExitCode>=0).
		if ee, ok := err.(*exec.ExitError); ok && ee.ProcessState.Exited() {
			return ee.ExitCode(), nil
		}
		return -1, err
	}
	return 0, nil
}

// Available reports whether the Docker daemon is reachable. Never errors.
func Available(ctx context.Context) bool {
	res, err := Run(ctx, 5*time.Second, "version", "--format", "{{.Server.Version}}")
	return err == nil && res.Code == 0
}

// ServerVersion returns the Docker engine version, or "" if unreachable.
func ServerVersion(ctx context.Context) string {
	res, err := Run(ctx, 5*time.Second, "version", "--format", "{{.Server.Version}}")
	if err != nil || res.Code != 0 {
		return ""
	}
	return strings.TrimSpace(res.Stdout)
}

// EnsureNetwork creates the shared external `deplo` network if it is missing.
func EnsureNetwork(ctx context.Context, name string) error {
	if res, err := Run(ctx, 10*time.Second, "network", "inspect", name); err == nil && res.Code == 0 {
		return nil
	}
	res, err := Run(ctx, 15*time.Second, "network", "create", name)
	if err != nil {
		return err
	}
	if res.Code != 0 {
		return fmt.Errorf("docker network create %s failed: %s", name, res.Stderr)
	}
	return nil
}

// RunningContainers counts containers in the running state. Best-effort: returns
// 0 on any failure.
func RunningContainers(ctx context.Context) int {
	res, err := Run(ctx, 10*time.Second, "ps", "-q")
	if err != nil || res.Code != 0 {
		return 0
	}
	n := 0
	for _, l := range strings.Split(strings.TrimSpace(res.Stdout), "\n") {
		if strings.TrimSpace(l) != "" {
			n++
		}
	}
	return n
}

// IsRunning reports whether a named container is in the running state. Used by
// the deploy readiness wait and Inspect. Never errors (false on any failure).
func IsRunning(ctx context.Context, name string) bool {
	res, err := Run(ctx, 5*time.Second, "inspect", "-f", "{{.State.Running}}", name)
	if err != nil || res.Code != 0 {
		return false
	}
	return strings.TrimSpace(res.Stdout) == "true"
}

// State returns (exists, runtimeState) for a container, e.g. ("running"). exists
// is false when docker has no such container.
func State(ctx context.Context, name string) (bool, string) {
	res, err := Run(ctx, 5*time.Second, "inspect", "-f", "{{.State.Status}}", name)
	if err != nil || res.Code != 0 {
		return false, ""
	}
	return true, strings.TrimSpace(res.Stdout)
}

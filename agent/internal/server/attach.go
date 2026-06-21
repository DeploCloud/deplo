package server

import (
	"errors"
	"io"
	"os"
	"os/exec"
	"sync"

	"github.com/creack/pty"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "github.com/idradev/deplo/agent/gen"
	"github.com/idradev/deplo/agent/internal/dockercli"
)

// attach.go ports lib/infra/docker.ts attachContainer + attachContainerPty to the
// agent: interactive `docker attach` over one bidi gRPC stream. The pty backing
// (creack/pty) lives in Go now (was Node node-pty), so a tty:true container gets
// a real pseudo-terminal regardless of which host the agent runs on.
//
// `--sig-proxy=false` is the shared guard: killing the agent's local attach
// client (client disconnect / detach) never forwards a signal to the container,
// so the app keeps running. A literal \x03 the caller writes still reaches a tty
// container as SIGINT — the genuine, opt-in interactive behaviour.

// attachClient abstracts the two backings (piped child / pty) the way the TS
// AttachHandle did, but with a direct read([]byte) model — gRPC pumps bytes, it
// does not register callbacks.
type attachClient interface {
	// read fills p with merged container output; returns io.EOF when the client
	// exits. Blocking.
	read(p []byte) (int, error)
	// write forwards keystroke bytes to the container stdin (best-effort).
	write(data []byte)
	// resize sets the terminal size (pty only; a no-op on pipes).
	resize(cols, rows int)
	// exitCode is valid only after read returned io.EOF (0 if unknown).
	exitCode() int
	// close tears down the agent's attach client only (never the container).
	close()
}

var attachArgs = func(name string) []string {
	return []string{"attach", "--sig-proxy=false", name}
}

// Attach is the bidi RPC. The first client frame MUST be AttachOpen.
func (s *Service) Attach(stream pb.Agent_AttachServer) error {
	first, err := stream.Recv()
	if err != nil {
		return err
	}
	open := first.GetOpen()
	if open == nil {
		return status.Error(codes.InvalidArgument, "first Attach frame must be an open frame")
	}
	ctx := stream.Context()
	if err := assertOwned(ctx, open.GetContainer(), open.GetProjectId()); err != nil {
		return err
	}
	// Attaching to a stopped container's PID 1 would just hang — refuse early,
	// mirroring resolveAttachTarget's "stopped" rejection (which the control plane
	// also does, but a remote container's liveness must be checked where it runs).
	if !dockercli.IsRunning(ctx, open.GetContainer()) {
		return status.Error(codes.FailedPrecondition, "container is not running")
	}

	var client attachClient
	if open.GetTty() {
		cols, rows := dimsOrDefault(int(open.GetCols()), int(open.GetRows()))
		client, err = newAttachPTY(open.GetContainer(), cols, rows)
	} else {
		client, err = newAttachPipes(open.GetContainer())
	}
	if err != nil {
		return status.Errorf(codes.Internal, "attach: %v", err)
	}
	defer client.close()

	// Output pump: container -> client. Runs until the attach client exits or a
	// send fails (the gRPC stream closed). Sends a terminal exit frame on EOF.
	outDone := make(chan struct{})
	go func() {
		defer close(outDone)
		buf := make([]byte, 32*1024)
		for {
			n, rerr := client.read(buf)
			if n > 0 {
				chunk := make([]byte, n)
				copy(chunk, buf[:n])
				if serr := stream.Send(&pb.AttachOutput{
					Frame: &pb.AttachOutput_Data{Data: chunk},
				}); serr != nil {
					return
				}
			}
			if rerr != nil {
				_ = stream.Send(&pb.AttachOutput{
					Frame: &pb.AttachOutput_Exit{Exit: &pb.AttachExit{Code: int32(client.exitCode())}},
				})
				return
			}
		}
	}()

	// Input pump: client -> container. Runs until the client half-closes the
	// stream (io.EOF), the context is cancelled, or the container exits.
	for {
		select {
		case <-outDone:
			// Container exited / output stream closed: stop reading input.
			return nil
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		in, rerr := stream.Recv()
		if rerr == io.EOF {
			// The browser closed the input direction; keep streaming output until
			// the container exits (outDone), then return.
			<-outDone
			return nil
		}
		if rerr != nil {
			return rerr
		}
		switch f := in.GetFrame().(type) {
		case *pb.AttachInput_Data:
			client.write(f.Data)
		case *pb.AttachInput_Resize:
			client.resize(int(f.Resize.GetCols()), int(f.Resize.GetRows()))
		case *pb.AttachInput_Open:
			// A second open frame is a protocol error; ignore it (the first one
			// already selected the container).
		}
	}
}

func dimsOrDefault(cols, rows int) (int, int) {
	if cols <= 0 {
		cols = 80
	}
	if rows <= 0 {
		rows = 24
	}
	return cols, rows
}

// ---- pipe backing (tty:false): docker attach over plain pipes -------------

type attachPipes struct {
	cmd       *exec.Cmd
	stdin     io.WriteCloser
	merged    chan []byte
	done      chan struct{} // closed by close() to unblock blocked pump sends
	closeOnce sync.Once
	code      int
}

func newAttachPipes(name string) (*attachPipes, error) {
	cmd := exec.Command("docker", attachArgs(name)...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	a := &attachPipes{
		cmd:    cmd,
		stdin:  stdin,
		merged: make(chan []byte, 16),
		done:   make(chan struct{}),
	}

	var wg sync.WaitGroup
	wg.Add(2)
	pump := func(r io.Reader) {
		defer wg.Done()
		buf := make([]byte, 32*1024)
		for {
			n, err := r.Read(buf)
			if n > 0 {
				chunk := make([]byte, n)
				copy(chunk, buf[:n])
				// Select on done so a send never blocks forever once the reader
				// has gone (close() fired): the pump exits instead of leaking.
				select {
				case a.merged <- chunk:
				case <-a.done:
					return
				}
			}
			if err != nil {
				return
			}
		}
	}
	go pump(stdout)
	go pump(stderr)
	// Once both pipes drain (process exited, or close() killed it), reap the
	// child and close merged so the reader sees io.EOF. The wait goroutine is the
	// SOLE closer of merged — close() never touches it (which would risk a
	// double-close panic or a send-on-closed-channel from a still-running pump).
	go func() {
		wg.Wait()
		werr := a.cmd.Wait()
		if ee := (&exec.ExitError{}); errors.As(werr, &ee) {
			a.code = ee.ExitCode()
		}
		close(a.merged)
	}()
	return a, nil
}

func (a *attachPipes) read(p []byte) (int, error) {
	select {
	case chunk, ok := <-a.merged:
		if !ok {
			return 0, io.EOF
		}
		n := copy(p, chunk)
		// A chunk larger than p is rare (p is 32KiB, matching the pump buffer);
		// the merged buffer is sized to the same 32KiB pump, so copy is full in
		// practice.
		return n, nil
	case <-a.done:
		// close() fired; stop reading promptly (the pumps/wait goroutine drain
		// and close merged on their own).
		return 0, io.EOF
	}
}

func (a *attachPipes) write(data []byte) {
	_, _ = a.stdin.Write(data) // best-effort; ignored if stdin is closed
}

func (a *attachPipes) resize(_, _ int) {} // no pty, nothing to resize

func (a *attachPipes) exitCode() int { return a.code }

func (a *attachPipes) close() {
	a.closeOnce.Do(func() { close(a.done) }) // unblock the pumps + read()
	_ = a.stdin.Close()
	if a.cmd.Process != nil {
		_ = a.cmd.Process.Kill() // sig-proxy=false => container untouched
	}
}

// ---- pty backing (tty:true): docker attach inside a pseudo-terminal -------

type attachPTY struct {
	cmd  *exec.Cmd
	ptmx *os.File
	code int
}

func newAttachPTY(name string, cols, rows int) (*attachPTY, error) {
	cmd := exec.Command("docker", attachArgs(name)...)
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
	if err != nil {
		return nil, err
	}
	return &attachPTY{cmd: cmd, ptmx: ptmx}, nil
}

func (a *attachPTY) read(p []byte) (int, error) {
	n, err := a.ptmx.Read(p)
	if err != nil {
		// The pty closes when the attach client exits; reap to capture the code.
		if a.cmd.ProcessState == nil {
			werr := a.cmd.Wait()
			if ee := (&exec.ExitError{}); errors.As(werr, &ee) {
				a.code = ee.ExitCode()
			}
		}
		return n, io.EOF
	}
	return n, nil
}

func (a *attachPTY) write(data []byte) { _, _ = a.ptmx.Write(data) }

func (a *attachPTY) resize(cols, rows int) {
	if cols <= 0 || rows <= 0 {
		return
	}
	_ = pty.Setsize(a.ptmx, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
}

func (a *attachPTY) exitCode() int { return a.code }

func (a *attachPTY) close() {
	_ = a.ptmx.Close()
	if a.cmd.Process != nil {
		_ = a.cmd.Process.Kill()
	}
}

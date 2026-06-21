package server

import (
	"context"
	"sync"
	"time"

	pb "github.com/idradev/deplo/agent/gen"
)

// inflight tracks one deploy the agent is running (or recently finished), keyed
// by its stable deploy id. It is the heart of reconnection/replay (PLAN D5,
// Part-B half): the deploy runs in a background goroutine on a DEPLOY-scoped
// context (not the gRPC stream's), so a control-plane disconnect does NOT kill
// the build. Every event the deploy emits is stamped with a monotonic seq and
// appended to `events`; a connecting (Deploy) or reconnecting (ReattachDeploy)
// stream replays `events` from a cursor, then receives live events until the
// terminal result. Finished deploys are retained briefly so a control plane that
// dropped right before the result can still fetch it.
type inflight struct {
	startedAt time.Time

	mu       sync.Mutex
	cond     *sync.Cond
	events   []*pb.DeployEvent // every event so far, seq == index+1
	phase    pb.DeployPhase
	done     bool            // terminal result has been appended
	finished time.Time       // when done flipped true (for retention/eviction)
	cancel   context.CancelFunc // cancels the deploy's background context
}

func newInflight(cancel context.CancelFunc) *inflight {
	f := &inflight{startedAt: time.Now(), cancel: cancel}
	f.cond = sync.NewCond(&f.mu)
	return f
}

// append stamps an event with the next seq, records phase/terminal transitions,
// and wakes every subscriber. Returns the stamped event (so the live path can
// also forward it without re-deriving the seq).
func (f *inflight) append(ev *pb.DeployEvent) *pb.DeployEvent {
	f.mu.Lock()
	defer f.mu.Unlock()
	ev.Seq = uint64(len(f.events) + 1)
	f.events = append(f.events, ev)
	if p := ev.GetPhase(); p != nil {
		f.phase = p.GetPhase()
	}
	if ev.GetResult() != nil {
		f.done = true
		f.finished = time.Now()
	}
	f.cond.Broadcast()
	return ev
}

// subscribe replays buffered events with seq > fromSeq, then streams live events
// until the deploy is done or ctx is cancelled (the SUBSCRIBER's context — i.e.
// the gRPC stream; cancelling it detaches this reader without affecting the
// deploy or other readers). send is the per-event sink; a send error detaches.
func (f *inflight) subscribe(ctx context.Context, fromSeq uint64, send func(*pb.DeployEvent) error) error {
	// A goroutine to wake the cond when the subscriber's context is cancelled,
	// so a detached reader doesn't block forever on cond.Wait().
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		select {
		case <-ctx.Done():
			f.mu.Lock()
			f.cond.Broadcast()
			f.mu.Unlock()
		case <-stop:
		}
	}()

	cursor := fromSeq
	for {
		f.mu.Lock()
		// Wait until there is an event past the cursor, or the deploy is done, or
		// the subscriber went away.
		for uint64(len(f.events)) <= cursor && !f.done && ctx.Err() == nil {
			f.cond.Wait()
		}
		if ctx.Err() != nil {
			f.mu.Unlock()
			return ctx.Err()
		}
		// Drain everything newly available under the lock into a local slice, then
		// send outside the lock (send may block on the network).
		var batch []*pb.DeployEvent
		for uint64(len(f.events)) > cursor {
			batch = append(batch, f.events[cursor])
			cursor++
		}
		// After draining, if the deploy is done and nothing new arrived, the
		// terminal result is among what we just (or previously) sent — finish.
		finished := f.done && uint64(len(f.events)) <= cursor
		f.mu.Unlock()

		for _, ev := range batch {
			if err := send(ev); err != nil {
				return err
			}
		}
		if finished {
			return nil
		}
	}
}

func (f *inflight) isDone() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.done
}

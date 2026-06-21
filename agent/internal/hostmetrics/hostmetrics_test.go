package hostmetrics

import "testing"

// Collect reads real /proc on the test host; assert the shape is sane rather
// than pinning values. It must not fabricate — but on a real Linux host the
// basic facts (cores >= 1, mem total > 0) hold.
func TestCollect_returnsSaneShape(t *testing.T) {
	m := Collect("/")
	if m.CPUCores < 1 {
		t.Errorf("CPUCores = %d, want >= 1", m.CPUCores)
	}
	if m.MemTotal <= 0 {
		t.Errorf("MemTotal = %d, want > 0", m.MemTotal)
	}
	if m.MemUsed < 0 || m.MemUsed > m.MemTotal {
		t.Errorf("MemUsed = %d out of range [0,%d]", m.MemUsed, m.MemTotal)
	}
	if m.CPU < 0 || m.CPU > 100 {
		t.Errorf("CPU = %f out of range [0,100]", m.CPU)
	}
	if m.DiskTotal < 0 {
		t.Errorf("DiskTotal = %d, want >= 0", m.DiskTotal)
	}
	if m.MemPct < 0 || m.MemPct > 100 {
		t.Errorf("MemPct = %f out of range", m.MemPct)
	}
}

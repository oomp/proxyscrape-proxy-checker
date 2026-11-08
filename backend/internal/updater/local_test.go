package updater

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestLocalBuildDoesNotContactOfficialUpdateService(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[{"version":"99.0.0","date":"2026-11-08","channel":"stable","notes":"fixture"}]`))
	}))
	defer server.Close()
	t.Setenv("UPDATES_URL", server.URL)

	result := Check(context.Background(), "2.4.0-local.1")
	if requests.Load() != 0 {
		t.Errorf("local build contacted an update service %d time(s)", requests.Load())
	}
	if result.HasUpdate || result.Latest != "2.4.0-local.1" || result.Current != "2.4.0-local.1" {
		t.Errorf("local build must keep its own version: %+v", result)
	}
}

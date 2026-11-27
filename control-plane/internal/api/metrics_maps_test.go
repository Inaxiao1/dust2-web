package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/duskrain/cs2-control-plane/internal/store"
	"github.com/duskrain/cs2-control-plane/internal/token"
)

type stubDistributedStore struct {
	*store.MemoryStore
	hits map[string]int
}

func (s *stubDistributedStore) AllowRate(key string, limit int, _ time.Duration) (bool, error) {
	if s.hits == nil {
		s.hits = make(map[string]int)
	}
	s.hits[key]++
	return s.hits[key] <= limit, nil
}

func TestMapPoolsAndPrometheusMetrics(t *testing.T) {
	now := time.Unix(1700000000, 0)
	mem := store.NewMemoryStore(15*time.Second, func() time.Time { return now })
	dist := &stubDistributedStore{MemoryStore: mem}
	signer, err := token.NewSigner([]byte("metrics-test-secret-32-bytes!!!!"), func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	srv, err := NewServer(Config{
		Store:           dist,
		Signer:          signer,
		WorkerAuthToken: "worker-secret",
		RateLimitPerMin: 2,
		Now:             func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}

	if err := mem.RegisterWorker(store.WorkerInfo{
		WorkerID: "w-dust2-1",
		WsURL:    "wss://w1.example.com/ws",
		Maps:     []string{"de_dust2"},
		MaxRooms: 4,
	}); err != nil {
		t.Fatal(err)
	}
	if err := mem.RegisterWorker(store.WorkerInfo{
		WorkerID: "w-mirage-1",
		WsURL:    "wss://w2.example.com/ws",
		Maps:     []string{"de_mirage"},
		MaxRooms: 2,
	}); err != nil {
		t.Fatal(err)
	}
	_ = mem.Heartbeat(store.WorkerHeartbeat{
		WorkerID:  "w-dust2-1",
		TickP99Ms: 11.5,
		Rooms: []store.RoomInfo{
			{Code: "ABCD12", MapID: "de_dust2", Mode: "defuse", Visibility: "public", Humans: 4, Bots: 6, Capacity: 10, Joinable: true},
		},
	})

	// 1) Check /api/v1/maps
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/maps", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/v1/maps expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var mapsResp struct {
		OK          bool             `json:"ok"`
		TotalMaps   int              `json:"totalMaps"`
		TotalHumans int              `json:"totalHumans"`
		Maps        []mapPoolSummary `json:"maps"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &mapsResp); err != nil {
		t.Fatal(err)
	}
	if !mapsResp.OK || mapsResp.TotalMaps != 2 || mapsResp.TotalHumans != 4 {
		t.Fatalf("unexpected maps response: %+v", mapsResp)
	}
	if mapsResp.Maps[0].MapID != "de_dust2" || mapsResp.Maps[0].AvailableSlots != 3 || mapsResp.Maps[0].Status != "ready" {
		t.Fatalf("unexpected dust2 pool: %+v", mapsResp.Maps[0])
	}

	// 2) Exercise distributed rate limiter (limit=2 -> 3rd POST returns 429)
	for i := 0; i < 3; i++ {
		body := bytes.NewBufferString(`{"mapId":"de_mirage","mode":"defuse","playerName":"Tester"}`)
		req := httptest.NewRequest(http.MethodPost, "/api/v1/rooms", body)
		req.Header.Set("X-Forwarded-For", "203.0.113.10")
		rr := httptest.NewRecorder()
		srv.ServeHTTP(rr, req)
		if i < 2 && rr.Code != http.StatusCreated {
			t.Fatalf("req %d expected 201, got %d: %s", i, rr.Code, rr.Body.String())
		}
		if i == 2 && rr.Code != http.StatusTooManyRequests {
			t.Fatalf("req %d expected 429 from distributed limiter, got %d", i, rr.Code)
		}
	}

	// 3) Check Prometheus /metrics exposition
	mRec := httptest.NewRecorder()
	srv.ServeHTTP(mRec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if mRec.Code != http.StatusOK {
		t.Fatalf("GET /metrics expected 200, got %d", mRec.Code)
	}
	if ct := mRec.Header().Get("Content-Type"); !strings.Contains(ct, "text/plain") {
		t.Fatalf("unexpected metrics Content-Type: %s", ct)
	}
	text := mRec.Body.String()
	for _, needle := range []string{
		"cs2_cp_up 1",
		`cs2_cp_workers{state="active"} 2`,
		`cs2_cp_requests_total{action="create_room"} 2`,
		"cs2_cp_tokens_issued_total 2",
		"cs2_cp_rate_limited_total 1",
		`cs2_cp_map_workers{map_id="de_dust2"} 1`,
		`cs2_cp_map_available_slots{map_id="de_dust2"} 3`,
	} {
		if !strings.Contains(text, needle) {
			t.Fatalf("expected %q in /metrics output:\n%s", needle, text)
		}
	}
}

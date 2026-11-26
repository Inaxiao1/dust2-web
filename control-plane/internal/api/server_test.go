package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/duskrain/cs2-control-plane/internal/store"
	"github.com/duskrain/cs2-control-plane/internal/token"
)

func newTestServer(t *testing.T, clock *time.Time) (*Server, *token.Signer) {
	t.Helper()
	nowFn := func() time.Time { return *clock }
	signer, err := token.NewSigner([]byte("test-hmac-secret-at-least-16-bytes"), nowFn)
	if err != nil {
		t.Fatalf("NewSigner: %v", err)
	}
	reg := store.NewMemoryStore(15*time.Second, nowFn)
	srv, err := NewServer(Config{
		Store:           reg,
		Signer:          signer,
		WorkerAuthToken: "worker-secret-token",
		AllowedOrigins:  []string{"https://cdn.duskrain.cn"},
		TokenTTL:        60 * time.Second,
	})
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	return srv, signer
}

func doJSON(t *testing.T, h http.Handler, method, path, bearer, origin string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			t.Fatalf("encode body: %v", err)
		}
	}
	req := httptest.NewRequest(method, path, &buf)
	req.Header.Set("Content-Type", "application/json")
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	return rr
}

func TestWorkerSchedulingJoinTokenAndDrainFlow(t *testing.T) {
	clock := time.Unix(1700000000, 0)
	srv, signer := newTestServer(t, &clock)

	// Unauthenticated worker registration is rejected.
	if rr := doJSON(t, srv, "POST", "/api/v1/workers/register", "", "", map[string]any{
		"workerId": "w1", "wsUrl": "wss://w1.example.com/ws", "maps": []string{"de_mirage"}, "maxRooms": 2,
	}); rr.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rr.Code)
	}

	// Register two mirage workers with different load/latency.
	for _, w := range []map[string]any{
		{"workerId": "w-busy", "wsUrl": "wss://busy.example.com/ws", "maps": []string{"de_mirage"}, "maxRooms": 2},
		{"workerId": "w-fast", "wsUrl": "wss://fast.example.com/ws", "maps": []string{"de_mirage"}, "maxRooms": 4},
	} {
		if rr := doJSON(t, srv, "POST", "/api/v1/workers/register", "worker-secret-token", "", w); rr.Code != http.StatusOK {
			t.Fatalf("register %s failed: %d %s", w["workerId"], rr.Code, rr.Body.String())
		}
	}

	// Heartbeat reports w-busy has an existing public room, w-fast is idle.
	if rr := doJSON(t, srv, "POST", "/api/v1/workers/heartbeat", "worker-secret-token", "", map[string]any{
		"workerId":  "w-busy",
		"tickP99Ms": 8.5,
		"rooms": []map[string]any{{
			"code": "ROOM01", "mapId": "de_mirage", "mode": "defuse", "visibility": "public",
			"humans": 3, "bots": 7, "capacity": 10, "phase": "live", "joinable": true,
		}},
	}); rr.Code != http.StatusOK {
		t.Fatalf("heartbeat failed: %d", rr.Code)
	}

	// Create room selects w-fast (0/4 load vs 1/2 load) and returns signed JoinToken + CORS.
	createRR := doJSON(t, srv, "POST", "/api/v1/rooms", "", "https://cdn.duskrain.cn", map[string]any{
		"mapId": "de_mirage", "mode": "defuse", "visibility": "public", "playerName": "Sniper",
	})
	if createRR.Code != http.StatusCreated {
		t.Fatalf("create room failed: %d %s", createRR.Code, createRR.Body.String())
	}
	if createRR.Header().Get("Access-Control-Allow-Origin") != "https://cdn.duskrain.cn" {
		t.Fatalf("missing CORS header: %q", createRR.Header().Get("Access-Control-Allow-Origin"))
	}
	var created struct {
		RoomCode    string `json:"roomCode"`
		WorkerID    string `json:"workerId"`
		WorkerWsURL string `json:"workerWsUrl"`
		JoinToken   string `json:"joinToken"`
	}
	_ = json.Unmarshal(createRR.Body.Bytes(), &created)
	if created.WorkerID != "w-fast" || created.WorkerWsURL != "wss://fast.example.com/ws" {
		t.Fatalf("expected w-fast, got %+v", created)
	}
	claims, err := signer.Verify(created.JoinToken)
	if err != nil || claims.RoomCode != created.RoomCode || claims.WorkerID != "w-fast" || claims.Action != "create" {
		t.Fatalf("invalid signed claims: err=%v claims=%+v", err, claims)
	}

	// Join existing public room on w-busy.
	joinRR := doJSON(t, srv, "POST", "/api/v1/rooms/ROOM01/join", "", "", map[string]any{"playerName": "Rifler"})
	if joinRR.Code != http.StatusOK {
		t.Fatalf("join failed: %d %s", joinRR.Code, joinRR.Body.String())
	}
	var joined struct {
		WorkerID  string `json:"workerId"`
		JoinToken string `json:"joinToken"`
	}
	_ = json.Unmarshal(joinRR.Body.Bytes(), &joined)
	if joined.WorkerID != "w-busy" {
		t.Fatalf("expected w-busy, got %s", joined.WorkerID)
	}

	// Draining w-busy prevents joining ROOM01 and marks it unjoinable in directory.
	if rr := doJSON(t, srv, "POST", "/api/v1/workers/w-busy/drain", "worker-secret-token", "", nil); rr.Code != http.StatusOK {
		t.Fatalf("drain worker failed: %d", rr.Code)
	}
	if rr := doJSON(t, srv, "POST", "/api/v1/rooms/ROOM01/join", "", "", nil); rr.Code != http.StatusConflict {
		t.Fatalf("expected 409 when worker draining, got %d", rr.Code)
	}

	dirRR := doJSON(t, srv, "GET", "/api/v1/rooms?mapId=de_mirage", "", "", nil)
	var dir struct {
		Rooms []store.RoomInfo `json:"rooms"`
	}
	_ = json.Unmarshal(dirRR.Body.Bytes(), &dir)
	if len(dir.Rooms) != 1 || dir.Rooms[0].Joinable {
		t.Fatalf("expected ROOM01 unjoinable, got %+v", dir.Rooms)
	}

	// TTL expiry removes stale workers and rooms cleanly.
	clock = clock.Add(16 * time.Second)
	if rr := doJSON(t, srv, "POST", "/api/v1/rooms", "", "", map[string]any{"mapId": "de_mirage"}); rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 after worker TTL expiry, got %d", rr.Code)
	}
}

func TestQuickJoinAndRateLimitAndPlayerUID(t *testing.T) {
	clock := time.Unix(1700001000, 0)
	nowFn := func() time.Time { return clock }
	signer, err := token.NewSigner([]byte("test-hmac-secret-at-least-16-bytes"), nowFn)
	if err != nil {
		t.Fatalf("NewSigner: %v", err)
	}
	reg := store.NewMemoryStore(15*time.Second, nowFn)
	srv, err := NewServer(Config{
		Store:           reg,
		Signer:          signer,
		WorkerAuthToken: "worker-secret-token",
		TokenTTL:        60 * time.Second,
		RateLimitPerMin: 60,
		RateLimitBurst:  3,
		Now:             nowFn,
	})
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}

	// Register dust2 and mirage workers.
	for _, w := range []map[string]any{
		{"workerId": "w-d2", "wsUrl": "wss://d2.example.com/ws", "maps": []string{"de_dust2"}, "maxRooms": 4},
		{"workerId": "w-m", "wsUrl": "wss://m.example.com/ws", "maps": []string{"de_mirage"}, "maxRooms": 4},
	} {
		if rr := doJSON(t, srv, "POST", "/api/v1/workers/register", "worker-secret-token", "", w); rr.Code != http.StatusOK {
			t.Fatalf("register failed: %d", rr.Code)
		}
	}

	// Preview when empty recommends create on preferredMap.
	prevEmpty := doJSON(t, srv, "GET", "/api/v1/quick-join?mode=deathmatch&preferredMap=de_mirage", "", "", nil)
	if prevEmpty.Code != http.StatusOK {
		t.Fatalf("quick-join preview failed: %d", prevEmpty.Code)
	}
	var prevBody map[string]any
	_ = json.Unmarshal(prevEmpty.Body.Bytes(), &prevBody)
	if prevBody["action"] != "create" || prevBody["mapId"] != "de_mirage" || prevBody["mode"] != "deathmatch" {
		t.Fatalf("unexpected empty preview: %+v", prevBody)
	}

	// Populate a live room on de_dust2.
	_ = doJSON(t, srv, "POST", "/api/v1/workers/heartbeat", "worker-secret-token", "", map[string]any{
		"workerId": "w-d2",
		"rooms": []map[string]any{{
			"code": "QJ0001", "mapId": "de_dust2", "mode": "defuse", "visibility": "public",
			"humans": 4, "bots": 6, "capacity": 10, "phase": "live", "joinable": true,
			"players": []string{"A", "B", "C", "D"},
		}},
	})

	// POST /api/v1/quick-join joins QJ0001 and embeds PlayerUID into signed token.
	qjRR := doJSON(t, srv, "POST", "/api/v1/quick-join", "", "", map[string]any{
		"mode": "defuse", "preferredMap": "de_mirage", "playerName": "Ghost", "playerUid": "TOY-998877",
	})
	if qjRR.Code != http.StatusOK {
		t.Fatalf("quick-join join failed: %d %s", qjRR.Code, qjRR.Body.String())
	}
	var qjResp struct {
		Action      string `json:"action"`
		RoomCode    string `json:"roomCode"`
		WorkerWsURL string `json:"workerWsUrl"`
		JoinToken   string `json:"joinToken"`
	}
	_ = json.Unmarshal(qjRR.Body.Bytes(), &qjResp)
	if qjResp.Action != "join" || qjResp.RoomCode != "QJ0001" || qjResp.WorkerWsURL != "wss://d2.example.com/ws" {
		t.Fatalf("unexpected quick-join resp: %+v", qjResp)
	}
	claims, err := signer.Verify(qjResp.JoinToken)
	if err != nil || claims.PlayerUID != "TOY-998877" || claims.Action != "join" {
		t.Fatalf("unexpected quick-join claims: err=%v claims=%+v", err, claims)
	}

	// Lookup room by code.
	getRR := doJSON(t, srv, "GET", "/api/v1/rooms/QJ0001", "", "", nil)
	if getRR.Code != http.StatusOK {
		t.Fatalf("get room failed: %d", getRR.Code)
	}

	// Burst=3: 1st request already used above, 2nd & 3rd succeed, 4th gets 429 RATE_LIMITED.
	for i := 0; i < 2; i++ {
		if rr := doJSON(t, srv, "POST", "/api/v1/quick-join", "", "", map[string]any{"mode": "defuse"}); rr.Code != http.StatusOK {
			t.Fatalf("request %d expected 200, got %d", i+2, rr.Code)
		}
	}
	limited := doJSON(t, srv, "POST", "/api/v1/quick-join", "", "", map[string]any{"mode": "defuse"})
	if limited.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 429 RATE_LIMITED, got %d %s", limited.Code, limited.Body.String())
	}
}

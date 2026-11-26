package api

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/duskrain/cs2-control-plane/internal/store"
	"github.com/duskrain/cs2-control-plane/internal/token"
)

var (
	mapIDPattern    = regexp.MustCompile(`^de_[a-z0-9]{1,32}$`)
	roomCodePattern = regexp.MustCompile(`^[A-Z0-9]{4,12}$`)
	workerIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)
	uidPattern      = regexp.MustCompile(`^[A-Za-z0-9._:@-]{1,128}$`)
)

type Config struct {
	Store           store.RegistryStore
	Signer          *token.Signer
	WorkerAuthToken string
	AllowedOrigins  []string
	TokenTTL        time.Duration
	RateLimitPerMin int
	RateLimitBurst  int
	Now             func() time.Time
}

type ipBucket struct {
	tokens   float64
	lastSeen time.Time
}

type ipRateLimiter struct {
	mu           sync.Mutex
	ratePerSec   float64
	burst        float64
	now          func() time.Time
	buckets      map[string]*ipBucket
}

func newIPRateLimiter(perMin, burst int, now func() time.Time) *ipRateLimiter {
	if perMin < 0 {
		return nil
	}
	if perMin == 0 {
		perMin = 60
	}
	if burst <= 0 {
		burst = 20
	}
	if now == nil {
		now = time.Now
	}
	return &ipRateLimiter{
		ratePerSec: float64(perMin) / 60.0,
		burst:      float64(burst),
		now:        now,
		buckets:    make(map[string]*ipBucket),
	}
}

func (l *ipRateLimiter) Allow(ip string) bool {
	if l == nil {
		return true
	}
	now := l.now()
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.buckets) > 2048 {
		for k, b := range l.buckets {
			if now.Sub(b.lastSeen) > 5*time.Minute {
				delete(l.buckets, k)
			}
		}
	}
	b, ok := l.buckets[ip]
	if !ok {
		l.buckets[ip] = &ipBucket{tokens: l.burst - 1, lastSeen: now}
		return true
	}
	elapsed := now.Sub(b.lastSeen).Seconds()
	if elapsed > 0 {
		b.tokens += elapsed * l.ratePerSec
		if b.tokens > l.burst {
			b.tokens = l.burst
		}
	}
	b.lastSeen = now
	if b.tokens < 1 {
		return false
	}
	b.tokens -= 1
	return true
}

type Server struct {
	cfg      Config
	draining atomic.Bool
	origins  map[string]struct{}
	wildcard bool
	limiter  *ipRateLimiter
	mux      *http.ServeMux
}

func NewServer(cfg Config) (*Server, error) {
	if cfg.Store == nil {
		return nil, errors.New("store is required")
	}
	if cfg.Signer == nil {
		return nil, errors.New("signer is required")
	}
	if cfg.TokenTTL <= 0 {
		cfg.TokenTTL = 60 * time.Second
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	s := &Server{
		cfg:     cfg,
		origins: make(map[string]struct{}),
		limiter: newIPRateLimiter(cfg.RateLimitPerMin, cfg.RateLimitBurst, cfg.Now),
		mux:     http.NewServeMux(),
	}
	for _, o := range cfg.AllowedOrigins {
		trimmed := strings.TrimSpace(o)
		if trimmed == "*" {
			s.wildcard = true
			break
		}
		if trimmed != "" {
			s.origins[trimmed] = struct{}{}
		}
	}

	s.mux.HandleFunc("GET /api/v1/health", s.handleHealth)
	s.mux.HandleFunc("GET /api/v1/ready", s.handleReady)
	s.mux.HandleFunc("GET /api/v1/rooms", s.handleListRooms)
	s.mux.HandleFunc("GET /api/v1/rooms/{code}", s.handleGetRoom)
	s.mux.HandleFunc("GET /api/v1/quick-join", s.handleQuickJoinPreview)
	s.mux.HandleFunc("POST /api/v1/quick-join", s.rateLimit(s.handleQuickJoin))
	s.mux.HandleFunc("POST /api/v1/rooms", s.rateLimit(s.handleCreateRoom))
	s.mux.HandleFunc("POST /api/v1/rooms/{code}/join", s.rateLimit(s.handleJoinRoom))
	s.mux.HandleFunc("GET /api/v1/workers", s.requireWorkerAuth(s.handleListWorkers))
	s.mux.HandleFunc("POST /api/v1/workers/register", s.requireWorkerAuth(s.handleRegisterWorker))
	s.mux.HandleFunc("POST /api/v1/workers/heartbeat", s.requireWorkerAuth(s.handleHeartbeat))
	s.mux.HandleFunc("POST /api/v1/workers/{id}/drain", s.requireWorkerAuth(s.handleDrainWorker))
	return s, nil
}

func (s *Server) BeginDrain() {
	s.draining.Store(true)
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	s.applyCORS(w, r)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	s.mux.ServeHTTP(w, r)
}

func (s *Server) applyCORS(w http.ResponseWriter, r *http.Request) {
	if s.wildcard {
		w.Header().Set("Access-Control-Allow-Origin", "*")
	} else if origin := r.Header.Get("Origin"); origin != "" {
		if _, ok := s.origins[origin]; ok {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Add("Vary", "Origin")
		}
	}
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
}

func clientIP(r *http.Request) string {
	if xff := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); xff != "" {
		if idx := strings.IndexByte(xff, ','); idx >= 0 {
			xff = strings.TrimSpace(xff[:idx])
		}
		if xff != "" {
			return xff
		}
	}
	if xri := strings.TrimSpace(r.Header.Get("X-Real-IP")); xri != "" {
		return xri
	}
	host, _, err := net.SplitHostPort(strings.TrimSpace(r.RemoteAddr))
	if err == nil && host != "" {
		return host
	}
	return strings.TrimSpace(r.RemoteAddr)
}

func (s *Server) rateLimit(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.limiter.Allow(clientIP(r)) {
			w.Header().Set("Retry-After", "1")
			writeError(w, http.StatusTooManyRequests, "RATE_LIMITED", "too many matchmaking requests, please retry shortly")
			return
		}
		next(w, r)
	}
}

func (s *Server) requireWorkerAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.cfg.WorkerAuthToken == "" {
			writeError(w, http.StatusForbidden, "WORKER_AUTH_DISABLED", "worker auth token not configured")
			return
		}
		auth := r.Header.Get("Authorization")
		if !strings.HasPrefix(auth, "Bearer ") {
			writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "missing bearer token")
			return
		}
		got := auth[len("Bearer "):]
		if subtle.ConstantTimeCompare([]byte(got), []byte(s.cfg.WorkerAuthToken)) != 1 {
			writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "invalid bearer token")
			return
		}
		next(w, r)
	}
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	stats := s.cfg.Store.Stats()
	draining := s.draining.Load()
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":       true,
		"ready":    !draining,
		"draining": draining,
		"service":  "cs2-control-plane",
		"stats":    stats,
	})
}

func (s *Server) handleReady(w http.ResponseWriter, _ *http.Request) {
	draining := s.draining.Load()
	code := http.StatusOK
	if draining {
		code = http.StatusServiceUnavailable
	}
	writeJSON(w, code, map[string]any{
		"ok":       true,
		"ready":    !draining,
		"draining": draining,
	})
}

func summarizeRooms(rooms []store.RoomInfo) (totalRooms, totalHumans, joinableRooms int) {
	totalRooms = len(rooms)
	for _, rm := range rooms {
		totalHumans += rm.Humans
		if rm.Joinable && rm.Humans < rm.Capacity {
			joinableRooms++
		}
	}
	return
}

func (s *Server) handleListRooms(w http.ResponseWriter, r *http.Request) {
	mapID := strings.TrimSpace(r.URL.Query().Get("mapId"))
	if mapID != "" && !mapIDPattern.MatchString(mapID) {
		writeError(w, http.StatusBadRequest, "INVALID_MAP_ID", "invalid mapId")
		return
	}
	rooms := s.cfg.Store.ListPublicRooms(mapID)
	if rooms == nil {
		rooms = []store.RoomInfo{}
	}
	totalRooms, totalHumans, joinableRooms := summarizeRooms(rooms)
	writeJSON(w, http.StatusOK, map[string]any{
		"rooms":         rooms,
		"totalRooms":    totalRooms,
		"totalHumans":   totalHumans,
		"joinableRooms": joinableRooms,
	})
}

func (s *Server) handleGetRoom(w http.ResponseWriter, r *http.Request) {
	code := strings.ToUpper(strings.TrimSpace(r.PathValue("code")))
	if !roomCodePattern.MatchString(code) {
		writeError(w, http.StatusBadRequest, "INVALID_ROOM_CODE", "invalid room code")
		return
	}
	room, worker, err := s.cfg.Store.GetRoomForJoin(code)
	if err != nil {
		if errors.Is(err, store.ErrRoomNotFound) {
			writeJSON(w, http.StatusNotFound, map[string]any{
				"found": false,
				"code":  "ROOM_GONE",
				"error": "未找到该房间码对应的活跃房间。",
			})
			return
		}
		writeJSON(w, http.StatusConflict, map[string]any{
			"found": false,
			"code":  "ROOM_UNAVAILABLE",
			"error": "房间已满、已结束或节点正在维护。",
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"found":       true,
		"room":        room,
		"workerId":    worker.WorkerID,
		"workerWsUrl": worker.WsURL,
	})
}

func pickQuickJoinCandidate(rooms []store.RoomInfo, wantedMode, preferredMap string) *store.RoomInfo {
	candidates := make([]store.RoomInfo, 0, len(rooms))
	for _, rm := range rooms {
		if rm.Joinable && rm.Humans < rm.Capacity {
			candidates = append(candidates, rm)
		}
	}
	if len(candidates) == 0 {
		return nil
	}
	sort.Slice(candidates, func(i, j int) bool {
		a, b := candidates[i], candidates[j]
		aMode := wantedMode != "any" && a.Mode == wantedMode
		bMode := wantedMode != "any" && b.Mode == wantedMode
		if aMode != bMode {
			return aMode
		}
		if a.Humans != b.Humans {
			return a.Humans > b.Humans
		}
		aPref := preferredMap != "" && a.MapID == preferredMap
		bPref := preferredMap != "" && b.MapID == preferredMap
		if aPref != bPref {
			return aPref
		}
		if a.MapID != b.MapID {
			return a.MapID < b.MapID
		}
		return a.Code < b.Code
	})
	picked := candidates[0]
	return &picked
}

func (s *Server) selectFallbackMapAndWorker(preferredMap string) (string, store.WorkerInfo, error) {
	tried := make([]string, 0, 3)
	if mapIDPattern.MatchString(preferredMap) {
		tried = append(tried, preferredMap)
	}
	if preferredMap != "de_dust2" {
		tried = append(tried, "de_dust2")
	}
	for _, m := range tried {
		if w, err := s.cfg.Store.SelectWorker(m); err == nil {
			return m, w, nil
		}
	}
	// Fall back to any map advertised by a healthy non-draining worker.
	for _, w := range s.cfg.Store.ListWorkers() {
		if w.Draining || w.ActiveRooms >= w.MaxRooms {
			continue
		}
		for _, m := range w.Maps {
			if m == "*" {
				return "de_dust2", w, nil
			}
			if mapIDPattern.MatchString(m) {
				if chosen, err := s.cfg.Store.SelectWorker(m); err == nil {
					return m, chosen, nil
				}
			}
		}
	}
	return "", store.WorkerInfo{}, store.ErrNoHealthyWorker
}

func (s *Server) handleQuickJoinPreview(w http.ResponseWriter, r *http.Request) {
	wantedMode := strings.TrimSpace(r.URL.Query().Get("mode"))
	if wantedMode != "defuse" && wantedMode != "deathmatch" {
		wantedMode = "any"
	}
	preferredMap := strings.TrimSpace(r.URL.Query().Get("preferredMap"))
	rooms := s.cfg.Store.ListPublicRooms("")
	totalRooms, totalHumans, joinableRooms := summarizeRooms(rooms)
	if candidate := pickQuickJoinCandidate(rooms, wantedMode, preferredMap); candidate != nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"action":        "join",
			"room":          candidate,
			"roomCode":      candidate.Code,
			"mapId":         candidate.MapID,
			"mode":          candidate.Mode,
			"totalRooms":    totalRooms,
			"totalHumans":   totalHumans,
			"joinableRooms": joinableRooms,
		})
		return
	}
	fallbackMode := "defuse"
	if wantedMode == "deathmatch" {
		fallbackMode = "deathmatch"
	}
	fallbackMap := "de_dust2"
	if m, _, err := s.selectFallbackMapAndWorker(preferredMap); err == nil {
		fallbackMap = m
	} else if mapIDPattern.MatchString(preferredMap) {
		fallbackMap = preferredMap
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"action":        "create",
		"mapId":         fallbackMap,
		"mode":          fallbackMode,
		"totalRooms":    totalRooms,
		"totalHumans":   totalHumans,
		"joinableRooms": 0,
	})
}

type quickJoinRequest struct {
	Mode         string `json:"mode"`
	PreferredMap string `json:"preferredMap"`
	PlayerName   string `json:"playerName"`
	PlayerUID    string `json:"playerUid"`
}

func (s *Server) handleQuickJoin(w http.ResponseWriter, r *http.Request) {
	if s.draining.Load() {
		writeError(w, http.StatusServiceUnavailable, "CONTROL_PLANE_DRAINING", "control plane is draining")
		return
	}
	var req quickJoinRequest
	if r.Body != nil && r.ContentLength != 0 {
		if err := decodeJSON(w, r, &req); err != nil {
			writeError(w, http.StatusBadRequest, "BAD_JSON", err.Error())
			return
		}
	}
	wantedMode := strings.TrimSpace(req.Mode)
	if wantedMode != "defuse" && wantedMode != "deathmatch" {
		wantedMode = "any"
	}
	preferredMap := strings.TrimSpace(req.PreferredMap)
	playerName := sanitizePlayerName(req.PlayerName)
	playerUID := sanitizePlayerUID(req.PlayerUID)

	rooms := s.cfg.Store.ListPublicRooms("")
	totalRooms, totalHumans, joinableRooms := summarizeRooms(rooms)
	if candidate := pickQuickJoinCandidate(rooms, wantedMode, preferredMap); candidate != nil {
		if room, worker, err := s.cfg.Store.GetRoomForJoin(candidate.Code); err == nil {
			signed, claims, err := s.cfg.Signer.Sign(token.Claims{
				RoomCode:   room.Code,
				MapID:      room.MapID,
				WorkerID:   worker.WorkerID,
				Action:     "join",
				Mode:       room.Mode,
				Visibility: room.Visibility,
				PlayerName: playerName,
				PlayerUID:  playerUID,
			}, s.cfg.TokenTTL)
			if err != nil {
				writeError(w, http.StatusInternalServerError, "TOKEN_SIGN_FAILED", "failed to sign join token")
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{
				"action":        "join",
				"room":          room,
				"roomCode":      room.Code,
				"mapId":         room.MapID,
				"mode":          room.Mode,
				"workerId":      worker.WorkerID,
				"workerWsUrl":   worker.WsURL,
				"joinToken":     signed,
				"expiresAt":     claims.ExpiresAt,
				"totalRooms":    totalRooms,
				"totalHumans":   totalHumans,
				"joinableRooms": joinableRooms,
			})
			return
		}
	}

	fallbackMode := "defuse"
	if wantedMode == "deathmatch" {
		fallbackMode = "deathmatch"
	}
	mapID, worker, err := s.selectFallbackMapAndWorker(preferredMap)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "NO_AVAILABLE_WORKER", err.Error())
		return
	}
	room, err := s.cfg.Store.AllocateRoomCode(worker.WorkerID, mapID, fallbackMode, "public")
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "ALLOCATION_FAILED", err.Error())
		return
	}
	signed, claims, err := s.cfg.Signer.Sign(token.Claims{
		RoomCode:   room.Code,
		MapID:      mapID,
		WorkerID:   worker.WorkerID,
		Action:     "create",
		Mode:       fallbackMode,
		Visibility: "public",
		PlayerName: playerName,
		PlayerUID:  playerUID,
	}, s.cfg.TokenTTL)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "TOKEN_SIGN_FAILED", "failed to sign join token")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"action":        "create",
		"roomCode":      room.Code,
		"mapId":         mapID,
		"mode":          fallbackMode,
		"visibility":    "public",
		"workerId":      worker.WorkerID,
		"workerWsUrl":   worker.WsURL,
		"joinToken":     signed,
		"expiresAt":     claims.ExpiresAt,
		"totalRooms":    totalRooms,
		"totalHumans":   totalHumans,
		"joinableRooms": joinableRooms,
	})
}

type createRoomRequest struct {
	MapID      string `json:"mapId"`
	Mode       string `json:"mode"`
	Visibility string `json:"visibility"`
	PlayerName string `json:"playerName"`
	PlayerUID  string `json:"playerUid"`
}

func (s *Server) handleCreateRoom(w http.ResponseWriter, r *http.Request) {
	if s.draining.Load() {
		writeError(w, http.StatusServiceUnavailable, "CONTROL_PLANE_DRAINING", "control plane is draining")
		return
	}
	var req createRoomRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_JSON", err.Error())
		return
	}
	if !mapIDPattern.MatchString(req.MapID) {
		writeError(w, http.StatusBadRequest, "INVALID_MAP_ID", "mapId must match de_*")
		return
	}
	mode := "defuse"
	if req.Mode == "deathmatch" {
		mode = "deathmatch"
	}
	visibility := "public"
	if req.Visibility == "private" {
		visibility = "private"
	}
	playerName := sanitizePlayerName(req.PlayerName)
	playerUID := sanitizePlayerUID(req.PlayerUID)

	worker, err := s.cfg.Store.SelectWorker(req.MapID)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "NO_AVAILABLE_WORKER", err.Error())
		return
	}
	room, err := s.cfg.Store.AllocateRoomCode(worker.WorkerID, req.MapID, mode, visibility)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "ALLOCATION_FAILED", err.Error())
		return
	}
	signed, claims, err := s.cfg.Signer.Sign(token.Claims{
		RoomCode:   room.Code,
		MapID:      req.MapID,
		WorkerID:   worker.WorkerID,
		Action:     "create",
		Mode:       mode,
		Visibility: visibility,
		PlayerName: playerName,
		PlayerUID:  playerUID,
	}, s.cfg.TokenTTL)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "TOKEN_SIGN_FAILED", "failed to sign join token")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"roomCode":    room.Code,
		"mapId":       req.MapID,
		"mode":        mode,
		"visibility":  visibility,
		"workerId":    worker.WorkerID,
		"workerWsUrl": worker.WsURL,
		"joinToken":   signed,
		"expiresAt":   claims.ExpiresAt,
	})
}

type joinRoomRequest struct {
	PlayerName string `json:"playerName"`
	PlayerUID  string `json:"playerUid"`
}

func (s *Server) handleJoinRoom(w http.ResponseWriter, r *http.Request) {
	if s.draining.Load() {
		writeError(w, http.StatusServiceUnavailable, "CONTROL_PLANE_DRAINING", "control plane is draining")
		return
	}
	code := strings.ToUpper(strings.TrimSpace(r.PathValue("code")))
	if !roomCodePattern.MatchString(code) {
		writeError(w, http.StatusBadRequest, "INVALID_ROOM_CODE", "invalid room code")
		return
	}
	var req joinRoomRequest
	if r.Body != nil && r.ContentLength != 0 {
		if err := decodeJSON(w, r, &req); err != nil {
			writeError(w, http.StatusBadRequest, "BAD_JSON", err.Error())
			return
		}
	}
	playerName := sanitizePlayerName(req.PlayerName)
	playerUID := sanitizePlayerUID(req.PlayerUID)

	room, worker, err := s.cfg.Store.GetRoomForJoin(code)
	if err != nil {
		if errors.Is(err, store.ErrRoomNotFound) {
			writeError(w, http.StatusNotFound, "ROOM_GONE", "room does not exist")
			return
		}
		writeError(w, http.StatusConflict, "ROOM_UNAVAILABLE", "room is full, ended, or worker draining")
		return
	}
	signed, claims, err := s.cfg.Signer.Sign(token.Claims{
		RoomCode:   room.Code,
		MapID:      room.MapID,
		WorkerID:   worker.WorkerID,
		Action:     "join",
		Mode:       room.Mode,
		Visibility: room.Visibility,
		PlayerName: playerName,
		PlayerUID:  playerUID,
	}, s.cfg.TokenTTL)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "TOKEN_SIGN_FAILED", "failed to sign join token")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"roomCode":    room.Code,
		"mapId":       room.MapID,
		"mode":        room.Mode,
		"workerId":    worker.WorkerID,
		"workerWsUrl": worker.WsURL,
		"joinToken":   signed,
		"expiresAt":   claims.ExpiresAt,
	})
}

func (s *Server) handleListWorkers(w http.ResponseWriter, _ *http.Request) {
	workers := s.cfg.Store.ListWorkers()
	if workers == nil {
		workers = []store.WorkerInfo{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"workers": workers,
	})
}

type registerWorkerRequest struct {
	WorkerID string   `json:"workerId"`
	WsURL    string   `json:"wsUrl"`
	Maps     []string `json:"maps"`
	MaxRooms int      `json:"maxRooms"`
	Region   string   `json:"region"`
}

func (s *Server) handleRegisterWorker(w http.ResponseWriter, r *http.Request) {
	var req registerWorkerRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_JSON", err.Error())
		return
	}
	if !workerIDPattern.MatchString(req.WorkerID) {
		writeError(w, http.StatusBadRequest, "INVALID_WORKER_ID", "invalid workerId")
		return
	}
	parsedWS, err := url.Parse(req.WsURL)
	if err != nil || (parsedWS.Scheme != "ws" && parsedWS.Scheme != "wss") || parsedWS.Host == "" {
		writeError(w, http.StatusBadRequest, "INVALID_WS_URL", "wsUrl must be a valid ws:// or wss:// URL")
		return
	}
	if len(req.Maps) == 0 {
		writeError(w, http.StatusBadRequest, "INVALID_MAPS", "at least one supported mapId or '*' is required")
		return
	}
	for _, m := range req.Maps {
		if m != "*" && !mapIDPattern.MatchString(m) {
			writeError(w, http.StatusBadRequest, "INVALID_MAP_ID", "invalid map entry: "+m)
			return
		}
	}
	if req.MaxRooms <= 0 || req.MaxRooms > 100 {
		req.MaxRooms = 1
	}

	if err := s.cfg.Store.RegisterWorker(store.WorkerInfo{
		WorkerID: req.WorkerID,
		WsURL:    req.WsURL,
		Maps:     req.Maps,
		MaxRooms: req.MaxRooms,
		Region:   req.Region,
	}); err != nil {
		writeError(w, http.StatusInternalServerError, "REGISTER_FAILED", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "workerId": req.WorkerID})
}

type heartbeatRequest struct {
	WorkerID  string           `json:"workerId"`
	Draining  bool             `json:"draining"`
	TickP99Ms float64          `json:"tickP99Ms"`
	Rooms     []store.RoomInfo `json:"rooms"`
}

func (s *Server) handleHeartbeat(w http.ResponseWriter, r *http.Request) {
	var req heartbeatRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_JSON", err.Error())
		return
	}
	if !workerIDPattern.MatchString(req.WorkerID) {
		writeError(w, http.StatusBadRequest, "INVALID_WORKER_ID", "invalid workerId")
		return
	}
	err := s.cfg.Store.Heartbeat(store.WorkerHeartbeat{
		WorkerID:  req.WorkerID,
		Draining:  req.Draining,
		TickP99Ms: req.TickP99Ms,
		Rooms:     req.Rooms,
	})
	if err != nil {
		if errors.Is(err, store.ErrWorkerNotFound) {
			writeError(w, http.StatusNotFound, "WORKER_NOT_REGISTERED", "worker must register first")
			return
		}
		writeError(w, http.StatusInternalServerError, "HEARTBEAT_FAILED", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleDrainWorker(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	if !workerIDPattern.MatchString(id) {
		writeError(w, http.StatusBadRequest, "INVALID_WORKER_ID", "invalid workerId")
		return
	}
	info, err := s.cfg.Store.MarkDraining(id)
	if err != nil {
		if errors.Is(err, store.ErrWorkerNotFound) {
			writeError(w, http.StatusNotFound, "WORKER_NOT_FOUND", "worker not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "DRAIN_FAILED", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "workerId": info.WorkerID, "draining": info.Draining})
}

func decodeJSON(w http.ResponseWriter, r *http.Request, dst any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 64*1024)
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(dst); err != nil {
		return err
	}
	return nil
}

func sanitizePlayerName(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "Player"
	}
	if len([]rune(trimmed)) > 20 {
		return string([]rune(trimmed)[:20])
	}
	return trimmed
}

func sanitizePlayerUID(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || !uidPattern.MatchString(trimmed) {
		return ""
	}
	return trimmed
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{
		"ok":      false,
		"code":    code,
		"message": message,
	})
}

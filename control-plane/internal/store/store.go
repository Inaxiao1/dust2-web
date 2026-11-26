package store

import (
	"crypto/rand"
	"errors"
	"math/big"
	"sort"
	"sync"
	"time"
)

var (
	ErrNoHealthyWorker = errors.New("no healthy battle worker available for requested map")
	ErrWorkerNotFound  = errors.New("worker not found")
	ErrRoomNotFound    = errors.New("room not found")
	ErrRoomUnavailable = errors.New("room unavailable or worker draining")
)

type WorkerInfo struct {
	WorkerID     string    `json:"workerId"`
	WsURL        string    `json:"wsUrl"`
	Maps         []string  `json:"maps"`
	MaxRooms     int       `json:"maxRooms"`
	ActiveRooms  int       `json:"activeRooms"`
	HumanCount   int       `json:"humanCount"`
	TickP99Ms    float64   `json:"tickP99Ms"`
	Region       string    `json:"region,omitempty"`
	Draining     bool      `json:"draining"`
	RegisteredAt time.Time `json:"registeredAt"`
	LastSeenAt   time.Time `json:"lastSeenAt"`
}

type RoomInfo struct {
	Code          string         `json:"code"`
	MapID         string         `json:"mapId"`
	WorkerID      string         `json:"workerId"`
	Mode          string         `json:"mode"`
	Visibility    string         `json:"visibility"`
	BotDifficulty string         `json:"botDifficulty,omitempty"`
	Humans        int            `json:"humans"`
	Bots          int            `json:"bots"`
	Capacity      int            `json:"capacity"`
	Phase         string         `json:"phase"`
	Joinable      bool           `json:"joinable"`
	Scores        map[string]int `json:"scores"`
	Players       []string       `json:"players,omitempty"`
	UpdatedAt     time.Time      `json:"updatedAt"`
}

type WorkerHeartbeat struct {
	WorkerID  string
	Draining  bool
	TickP99Ms float64
	Rooms     []RoomInfo
}

type RegistryStats struct {
	ActiveWorkers   int `json:"activeWorkers"`
	DrainingWorkers int `json:"drainingWorkers"`
	PublicRooms     int `json:"publicRooms"`
	TotalRooms      int `json:"totalRooms"`
}

// RegistryStore abstracts worker and room state so MemoryStore can be swapped
// for a Redis/Valkey implementation in multi-replica production deployments.
type RegistryStore interface {
	RegisterWorker(info WorkerInfo) error
	Heartbeat(hb WorkerHeartbeat) error
	MarkDraining(workerID string) (WorkerInfo, error)
	SelectWorker(mapID string) (WorkerInfo, error)
	AllocateRoomCode(workerID, mapID, mode, visibility string) (RoomInfo, error)
	GetRoomForJoin(code string) (RoomInfo, WorkerInfo, error)
	ListPublicRooms(mapID string) []RoomInfo
	ListWorkers() []WorkerInfo
	Stats() RegistryStats
}

type MemoryStore struct {
	mu        sync.RWMutex
	workerTTL time.Duration
	now       func() time.Time
	workers   map[string]*WorkerInfo
	rooms     map[string]*RoomInfo
}

func NewMemoryStore(workerTTL time.Duration, now func() time.Time) *MemoryStore {
	if workerTTL <= 0 {
		workerTTL = 15 * time.Second
	}
	if now == nil {
		now = time.Now
	}
	return &MemoryStore{
		workerTTL: workerTTL,
		now:       now,
		workers:   make(map[string]*WorkerInfo),
		rooms:     make(map[string]*RoomInfo),
	}
}

func (m *MemoryStore) isAliveLocked(w *WorkerInfo, now time.Time) bool {
	return now.Sub(w.LastSeenAt) <= m.workerTTL
}

func (m *MemoryStore) pruneExpiredLocked(now time.Time) {
	for id, w := range m.workers {
		if !m.isAliveLocked(w, now) {
			delete(m.workers, id)
			for code, r := range m.rooms {
				if r.WorkerID == id {
					delete(m.rooms, code)
				}
			}
		}
	}
}

func (m *MemoryStore) RegisterWorker(info WorkerInfo) error {
	now := m.now()
	m.mu.Lock()
	defer m.mu.Unlock()
	m.pruneExpiredLocked(now)

	copyInfo := info
	copyInfo.Maps = append([]string(nil), info.Maps...)
	if copyInfo.MaxRooms <= 0 {
		copyInfo.MaxRooms = 1
	}
	if existing, ok := m.workers[info.WorkerID]; ok {
		copyInfo.RegisteredAt = existing.RegisteredAt
		copyInfo.ActiveRooms = existing.ActiveRooms
		copyInfo.HumanCount = existing.HumanCount
	} else {
		copyInfo.RegisteredAt = now
	}
	copyInfo.LastSeenAt = now
	m.workers[info.WorkerID] = &copyInfo
	return nil
}

func (m *MemoryStore) Heartbeat(hb WorkerHeartbeat) error {
	now := m.now()
	m.mu.Lock()
	defer m.mu.Unlock()
	m.pruneExpiredLocked(now)

	w, ok := m.workers[hb.WorkerID]
	if !ok {
		return ErrWorkerNotFound
	}
	w.LastSeenAt = now
	w.Draining = w.Draining || hb.Draining
	w.TickP99Ms = hb.TickP99Ms
	w.ActiveRooms = len(hb.Rooms)

	humans := 0
	seenCodes := make(map[string]struct{}, len(hb.Rooms))
	for _, r := range hb.Rooms {
		humans += r.Humans
		seenCodes[r.Code] = struct{}{}
		copyRoom := r
		copyRoom.WorkerID = hb.WorkerID
		copyRoom.UpdatedAt = now
		if w.Draining {
			copyRoom.Joinable = false
		}
		if copyRoom.Scores == nil {
			copyRoom.Scores = map[string]int{"CT": 0, "T": 0}
		}
		m.rooms[r.Code] = &copyRoom
	}
	w.HumanCount = humans

	// Remove rooms owned by this worker that were closed since last heartbeat,
	// while keeping freshly allocated rooms not yet picked up within a short grace window.
	pendingGrace := 0
	for code, existing := range m.rooms {
		if existing.WorkerID == hb.WorkerID {
			if _, ok := seenCodes[code]; !ok {
				if now.Sub(existing.UpdatedAt) > 10*time.Second {
					delete(m.rooms, code)
				} else {
					pendingGrace++
				}
			}
		}
	}
	w.ActiveRooms = len(hb.Rooms) + pendingGrace
	return nil
}

func (m *MemoryStore) MarkDraining(workerID string) (WorkerInfo, error) {
	now := m.now()
	m.mu.Lock()
	defer m.mu.Unlock()
	m.pruneExpiredLocked(now)

	w, ok := m.workers[workerID]
	if !ok {
		return WorkerInfo{}, ErrWorkerNotFound
	}
	w.Draining = true
	for _, r := range m.rooms {
		if r.WorkerID == workerID {
			r.Joinable = false
		}
	}
	return *w, nil
}

func supportsMap(maps []string, target string) bool {
	for _, m := range maps {
		if m == "*" || m == target {
			return true
		}
	}
	return false
}

func (m *MemoryStore) SelectWorker(mapID string) (WorkerInfo, error) {
	now := m.now()
	m.mu.Lock()
	defer m.mu.Unlock()
	m.pruneExpiredLocked(now)

	candidates := make([]*WorkerInfo, 0, len(m.workers))
	for _, w := range m.workers {
		if w.Draining || w.ActiveRooms >= w.MaxRooms || !supportsMap(w.Maps, mapID) {
			continue
		}
		candidates = append(candidates, w)
	}
	if len(candidates) == 0 {
		return WorkerInfo{}, ErrNoHealthyWorker
	}

	sort.Slice(candidates, func(i, j int) bool {
		a, b := candidates[i], candidates[j]
		// Prefer dedicated warm-map workers over wildcard workers when both have capacity.
		aDedicated := len(a.Maps) == 1 && a.Maps[0] == mapID
		bDedicated := len(b.Maps) == 1 && b.Maps[0] == mapID
		if aDedicated != bDedicated {
			return aDedicated
		}
		loadA := float64(a.ActiveRooms) / float64(a.MaxRooms)
		loadB := float64(b.ActiveRooms) / float64(b.MaxRooms)
		if loadA != loadB {
			return loadA < loadB
		}
		if a.TickP99Ms != b.TickP99Ms {
			return a.TickP99Ms < b.TickP99Ms
		}
		if a.HumanCount != b.HumanCount {
			return a.HumanCount < b.HumanCount
		}
		return a.WorkerID < b.WorkerID
	})
	return *candidates[0], nil
}

func (m *MemoryStore) AllocateRoomCode(workerID, mapID, mode, visibility string) (RoomInfo, error) {
	now := m.now()
	m.mu.Lock()
	defer m.mu.Unlock()
	m.pruneExpiredLocked(now)

	w, ok := m.workers[workerID]
	if !ok || w.Draining || w.ActiveRooms >= w.MaxRooms {
		return RoomInfo{}, ErrNoHealthyWorker
	}
	var code string
	for i := 0; i < 16; i++ {
		candidate, err := randomRoomCode(6)
		if err != nil {
			return RoomInfo{}, err
		}
		if _, exists := m.rooms[candidate]; !exists {
			code = candidate
			break
		}
	}
	if code == "" {
		return RoomInfo{}, errors.New("failed to allocate unique room code")
	}

	room := RoomInfo{
		Code:       code,
		MapID:      mapID,
		WorkerID:   workerID,
		Mode:       mode,
		Visibility: visibility,
		Humans:     0,
		Bots:       0,
		Capacity:   10,
		Phase:      "waiting",
		Joinable:   true,
		Scores:     map[string]int{"CT": 0, "T": 0},
		UpdatedAt:  now,
	}
	m.rooms[code] = &room
	w.ActiveRooms++
	return room, nil
}

func (m *MemoryStore) GetRoomForJoin(code string) (RoomInfo, WorkerInfo, error) {
	now := m.now()
	m.mu.Lock()
	defer m.mu.Unlock()
	m.pruneExpiredLocked(now)

	r, ok := m.rooms[code]
	if !ok {
		return RoomInfo{}, WorkerInfo{}, ErrRoomNotFound
	}
	w, ok := m.workers[r.WorkerID]
	if !ok {
		return RoomInfo{}, WorkerInfo{}, ErrRoomNotFound
	}
	if w.Draining || !r.Joinable || r.Humans >= r.Capacity || r.Phase == "ended" {
		return RoomInfo{}, WorkerInfo{}, ErrRoomUnavailable
	}
	return *r, *w, nil
}

func (m *MemoryStore) ListPublicRooms(mapID string) []RoomInfo {
	now := m.now()
	m.mu.Lock()
	defer m.mu.Unlock()
	m.pruneExpiredLocked(now)

	out := make([]RoomInfo, 0, len(m.rooms))
	for _, r := range m.rooms {
		if r.Visibility != "public" || r.Humans <= 0 {
			continue
		}
		if mapID != "" && r.MapID != mapID {
			continue
		}
		copyRoom := *r
		if w, ok := m.workers[r.WorkerID]; !ok || w.Draining {
			copyRoom.Joinable = false
		}
		out = append(out, copyRoom)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Joinable != out[j].Joinable {
			return out[i].Joinable
		}
		if out[i].Humans != out[j].Humans {
			return out[i].Humans > out[j].Humans
		}
		return out[i].Code < out[j].Code
	})
	return out
}

func (m *MemoryStore) ListWorkers() []WorkerInfo {
	now := m.now()
	m.mu.Lock()
	defer m.mu.Unlock()
	m.pruneExpiredLocked(now)

	out := make([]WorkerInfo, 0, len(m.workers))
	for _, w := range m.workers {
		copyW := *w
		copyW.Maps = append([]string(nil), w.Maps...)
		out = append(out, copyW)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].WorkerID < out[j].WorkerID })
	return out
}

func (m *MemoryStore) Stats() RegistryStats {
	now := m.now()
	m.mu.Lock()
	defer m.mu.Unlock()
	m.pruneExpiredLocked(now)

	stats := RegistryStats{TotalRooms: len(m.rooms)}
	for _, w := range m.workers {
		if w.Draining {
			stats.DrainingWorkers++
		} else {
			stats.ActiveWorkers++
		}
	}
	for _, r := range m.rooms {
		if r.Visibility == "public" && r.Humans > 0 {
			stats.PublicRooms++
		}
	}
	return stats
}

func randomRoomCode(length int) (string, error) {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	out := make([]byte, length)
	max := big.NewInt(int64(len(alphabet)))
	for i := range out {
		n, err := rand.Int(rand.Reader, max)
		if err != nil {
			return "", err
		}
		out[i] = alphabet[n.Int64()]
	}
	return string(out), nil
}

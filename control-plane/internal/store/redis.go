package store

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type RedisConfig struct {
	Addr      string
	Password  string
	KeyPrefix string
	WorkerTTL time.Duration
	Timeout   time.Duration
	PoolSize  int
}

type respConn struct {
	conn   net.Conn
	reader *bufio.Reader
}

func (c *respConn) close() {
	if c != nil && c.conn != nil {
		_ = c.conn.Close()
	}
}

func (c *respConn) doRaw(timeout time.Duration, args ...string) (any, error) {
	_ = c.conn.SetDeadline(time.Now().Add(timeout))
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("*%d\r\n", len(args)))
	for _, a := range args {
		sb.WriteString(fmt.Sprintf("$%d\r\n%s\r\n", len(a), a))
	}
	if _, err := io.WriteString(c.conn, sb.String()); err != nil {
		return nil, err
	}
	return readRespValue(c.reader)
}

// respPool is a zero-dependency pooled RESP2 client supporting concurrent
// goroutines without serializing behind a single socket mutex.
type respPool struct {
	addr     string
	password string
	timeout  time.Duration
	pool     chan *respConn
	mu       sync.RWMutex
	closed   bool
}

func newRespPool(addr, password string, timeout time.Duration, poolSize int) *respPool {
	if timeout <= 0 {
		timeout = 3 * time.Second
	}
	if poolSize <= 0 {
		poolSize = 16
	}
	return &respPool{
		addr:     addr,
		password: password,
		timeout:  timeout,
		pool:     make(chan *respConn, poolSize),
	}
}

func (p *respPool) dial() (*respConn, error) {
	conn, err := net.DialTimeout("tcp", p.addr, p.timeout)
	if err != nil {
		return nil, err
	}
	rc := &respConn{conn: conn, reader: bufio.NewReader(conn)}
	if p.password != "" {
		if _, err := rc.doRaw(p.timeout, "AUTH", p.password); err != nil {
			rc.close()
			return nil, err
		}
	}
	return rc, nil
}

func (p *respPool) acquire() (*respConn, error) {
	p.mu.RLock()
	closed := p.closed
	p.mu.RUnlock()
	if closed {
		return nil, errors.New("redis pool closed")
	}
	select {
	case rc := <-p.pool:
		if rc != nil {
			return rc, nil
		}
	default:
	}
	return p.dial()
}

func (p *respPool) release(rc *respConn, broken bool) {
	if rc == nil {
		return
	}
	if broken {
		rc.close()
		return
	}
	p.mu.RLock()
	closed := p.closed
	p.mu.RUnlock()
	if closed {
		rc.close()
		return
	}
	select {
	case p.pool <- rc:
	default:
		rc.close()
	}
}

func (p *respPool) Close() error {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return nil
	}
	p.closed = true
	p.mu.Unlock()
	for {
		select {
		case rc := <-p.pool:
			rc.close()
		default:
			return nil
		}
	}
}

func (p *respPool) Do(args ...string) (any, error) {
	rc, err := p.acquire()
	if err != nil {
		return nil, err
	}
	val, err := rc.doRaw(p.timeout, args...)
	if err != nil {
		p.release(rc, true)
		// Retry once on transient broken pooled connection.
		rc2, err2 := p.dial()
		if err2 != nil {
			return nil, err
		}
		val, err = rc2.doRaw(p.timeout, args...)
		p.release(rc2, err != nil)
		return val, err
	}
	p.release(rc, false)
	return val, nil
}

func readRespValue(r *bufio.Reader) (any, error) {
	line, err := r.ReadString('\n')
	if err != nil {
		return nil, err
	}
	line = strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r")
	if len(line) == 0 {
		return nil, errors.New("empty resp line")
	}
	switch line[0] {
	case '+':
		return line[1:], nil
	case '-':
		return nil, errors.New(line[1:])
	case ':':
		return strconv.ParseInt(line[1:], 10, 64)
	case '$':
		n, err := strconv.Atoi(line[1:])
		if err != nil {
			return nil, err
		}
		if n < 0 {
			return nil, nil
		}
		buf := make([]byte, n+2)
		if _, err := io.ReadFull(r, buf); err != nil {
			return nil, err
		}
		return string(buf[:n]), nil
	case '*':
		n, err := strconv.Atoi(line[1:])
		if err != nil {
			return nil, err
		}
		if n < 0 {
			return nil, nil
		}
		arr := make([]any, n)
		for i := 0; i < n; i++ {
			v, err := readRespValue(r)
			if err != nil {
				return nil, err
			}
			arr[i] = v
		}
		return arr, nil
	default:
		return nil, fmt.Errorf("unexpected resp prefix: %q", line[0])
	}
}

// RedisStore implements RegistryStore backed by Redis/Valkey so multiple
// stateless Go Control Plane replicas share worker & room state with pooled
// connections, MGET batch reads, atomic NX room allocation, and heartbeat pruning.
type RedisStore struct {
	client    *respPool
	prefix    string
	workerTTL time.Duration
	now       func() time.Time
}

func NewRedisStore(cfg RedisConfig, now func() time.Time) (*RedisStore, error) {
	if cfg.Addr == "" {
		return nil, errors.New("redis addr is required")
	}
	if cfg.KeyPrefix == "" {
		cfg.KeyPrefix = "cs2"
	}
	if cfg.WorkerTTL <= 0 {
		cfg.WorkerTTL = 15 * time.Second
	}
	if now == nil {
		now = time.Now
	}
	client := newRespPool(cfg.Addr, cfg.Password, cfg.Timeout, cfg.PoolSize)
	if _, err := client.Do("PING"); err != nil {
		_ = client.Close()
		return nil, fmt.Errorf("redis ping failed: %w", err)
	}
	return &RedisStore{
		client:    client,
		prefix:    cfg.KeyPrefix,
		workerTTL: cfg.WorkerTTL,
		now:       now,
	}, nil
}

func (r *RedisStore) Close() error {
	return r.client.Close()
}

func (r *RedisStore) workerKey(id string) string       { return r.prefix + ":worker:" + id }
func (r *RedisStore) workerRoomsKey(id string) string  { return r.prefix + ":worker-rooms:" + id }
func (r *RedisStore) workersIndex() string             { return r.prefix + ":workers:index" }
func (r *RedisStore) roomKey(code string) string       { return r.prefix + ":room:" + code }
func (r *RedisStore) roomsIndex() string               { return r.prefix + ":rooms:index" }
func (r *RedisStore) ttlSeconds(d time.Duration) string {
	s := int(d.Seconds())
	if s < 1 {
		s = 1
	}
	return strconv.Itoa(s)
}

func (r *RedisStore) getJSON(key string, dst any) (bool, error) {
	raw, err := r.client.Do("GET", key)
	if err != nil {
		return false, err
	}
	if raw == nil {
		return false, nil
	}
	str, ok := raw.(string)
	if !ok {
		return false, errors.New("unexpected non-string redis value")
	}
	if err := json.Unmarshal([]byte(str), dst); err != nil {
		return false, err
	}
	return true, nil
}

func (r *RedisStore) mgetStrings(keys []string) ([]*string, error) {
	if len(keys) == 0 {
		return nil, nil
	}
	args := make([]string, 0, len(keys)+1)
	args = append(args, "MGET")
	args = append(args, keys...)
	raw, err := r.client.Do(args...)
	if err != nil {
		return nil, err
	}
	arr, ok := raw.([]any)
	if !ok {
		return nil, errors.New("unexpected non-array MGET response")
	}
	out := make([]*string, len(keys))
	for i := 0; i < len(keys) && i < len(arr); i++ {
		if s, ok := arr[i].(string); ok {
			copyStr := s
			out[i] = &copyStr
		}
	}
	return out, nil
}

func (r *RedisStore) setJSON(key string, ttl time.Duration, value any) error {
	bytes, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = r.client.Do("SET", key, string(bytes), "EX", r.ttlSeconds(ttl))
	return err
}

func (r *RedisStore) setJSONNX(key string, ttl time.Duration, value any) (bool, error) {
	bytes, err := json.Marshal(value)
	if err != nil {
		return false, err
	}
	res, err := r.client.Do("SET", key, string(bytes), "EX", r.ttlSeconds(ttl), "NX")
	if err != nil {
		return false, err
	}
	if res == nil {
		return false, nil
	}
	return true, nil
}

func (r *RedisStore) sremMany(key string, members []string) {
	if len(members) == 0 {
		return
	}
	args := make([]string, 0, len(members)+2)
	args = append(args, "SREM", key)
	args = append(args, members...)
	_, _ = r.client.Do(args...)
}

func (r *RedisStore) smembers(key string) ([]string, error) {
	raw, err := r.client.Do("SMEMBERS", key)
	if err != nil {
		return nil, err
	}
	arr, ok := raw.([]any)
	if !ok {
		return nil, nil
	}
	out := make([]string, 0, len(arr))
	for _, item := range arr {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	return out, nil
}

func (r *RedisStore) RegisterWorker(info WorkerInfo) error {
	now := r.now()
	var existing WorkerInfo
	found, _ := r.getJSON(r.workerKey(info.WorkerID), &existing)
	if info.MaxRooms <= 0 {
		info.MaxRooms = 1
	}
	if found {
		info.RegisteredAt = existing.RegisteredAt
		info.ActiveRooms = existing.ActiveRooms
		info.HumanCount = existing.HumanCount
		info.Draining = existing.Draining || info.Draining
	} else {
		info.RegisteredAt = now
	}
	info.LastSeenAt = now
	if err := r.setJSON(r.workerKey(info.WorkerID), r.workerTTL, info); err != nil {
		return err
	}
	_, err := r.client.Do("SADD", r.workersIndex(), info.WorkerID)
	return err
}

func (r *RedisStore) Heartbeat(hb WorkerHeartbeat) error {
	now := r.now()
	var w WorkerInfo
	found, err := r.getJSON(r.workerKey(hb.WorkerID), &w)
	if err != nil {
		return err
	}
	if !found {
		return ErrWorkerNotFound
	}
	w.LastSeenAt = now
	w.Draining = w.Draining || hb.Draining
	w.TickP99Ms = hb.TickP99Ms

	humans := 0
	roomTTL := r.workerTTL + 5*time.Second
	seenCodes := make(map[string]struct{}, len(hb.Rooms))
	workerSetKey := r.workerRoomsKey(hb.WorkerID)
	for _, rm := range hb.Rooms {
		humans += rm.Humans
		seenCodes[rm.Code] = struct{}{}
		copyRoom := rm
		copyRoom.WorkerID = hb.WorkerID
		copyRoom.UpdatedAt = now
		if w.Draining {
			copyRoom.Joinable = false
		}
		if copyRoom.Scores == nil {
			copyRoom.Scores = map[string]int{"CT": 0, "T": 0}
		}
		if err := r.setJSON(r.roomKey(copyRoom.Code), roomTTL, copyRoom); err != nil {
			return err
		}
		_, _ = r.client.Do("SADD", r.roomsIndex(), copyRoom.Code)
		_, _ = r.client.Do("SADD", workerSetKey, copyRoom.Code)
	}

	// Prune rooms previously owned by this worker that were closed since last
	// heartbeat, while honoring a 10s grace window for freshly allocated codes.
	pendingGrace := 0
	ownedCodes, _ := r.smembers(workerSetKey)
	if len(ownedCodes) > 0 {
		missingCodes := make([]string, 0)
		missingKeys := make([]string, 0)
		for _, code := range ownedCodes {
			if _, ok := seenCodes[code]; !ok {
				missingCodes = append(missingCodes, code)
				missingKeys = append(missingKeys, r.roomKey(code))
			}
		}
		if len(missingCodes) > 0 {
			vals, err := r.mgetStrings(missingKeys)
			if err == nil {
				stale := make([]string, 0)
				for i, code := range missingCodes {
					if vals[i] == nil {
						stale = append(stale, code)
						continue
					}
					var existing RoomInfo
					if err := json.Unmarshal([]byte(*vals[i]), &existing); err != nil {
						stale = append(stale, code)
						continue
					}
					if existing.WorkerID == hb.WorkerID && now.Sub(existing.UpdatedAt) > 10*time.Second {
						_, _ = r.client.Do("DEL", r.roomKey(code))
						stale = append(stale, code)
					} else if existing.WorkerID == hb.WorkerID {
						pendingGrace++
					} else {
						stale = append(stale, code)
					}
				}
				if len(stale) > 0 {
					r.sremMany(r.roomsIndex(), stale)
					r.sremMany(workerSetKey, stale)
				}
			}
		}
	}

	w.ActiveRooms = len(hb.Rooms) + pendingGrace
	w.HumanCount = humans
	return r.setJSON(r.workerKey(hb.WorkerID), r.workerTTL, w)
}

func (r *RedisStore) MarkDraining(workerID string) (WorkerInfo, error) {
	var w WorkerInfo
	found, err := r.getJSON(r.workerKey(workerID), &w)
	if err != nil {
		return WorkerInfo{}, err
	}
	if !found {
		return WorkerInfo{}, ErrWorkerNotFound
	}
	w.Draining = true
	if err := r.setJSON(r.workerKey(workerID), r.workerTTL, w); err != nil {
		return WorkerInfo{}, err
	}
	// Mark owned rooms unjoinable immediately using batched MGET.
	codes, _ := r.smembers(r.roomsIndex())
	if len(codes) > 0 {
		keys := make([]string, len(codes))
		for i, c := range codes {
			keys[i] = r.roomKey(c)
		}
		vals, err := r.mgetStrings(keys)
		if err == nil {
			for i, raw := range vals {
				if raw == nil {
					continue
				}
				var rm RoomInfo
				if json.Unmarshal([]byte(*raw), &rm) == nil && rm.WorkerID == workerID {
					rm.Joinable = false
					_ = r.setJSON(r.roomKey(codes[i]), r.workerTTL+5*time.Second, rm)
				}
			}
		}
	}
	return w, nil
}

func (r *RedisStore) loadLiveWorkers() []WorkerInfo {
	ids, err := r.smembers(r.workersIndex())
	if err != nil || len(ids) == 0 {
		return nil
	}
	keys := make([]string, len(ids))
	for i, id := range ids {
		keys[i] = r.workerKey(id)
	}
	vals, err := r.mgetStrings(keys)
	if err != nil {
		return nil
	}
	out := make([]WorkerInfo, 0, len(ids))
	stale := make([]string, 0)
	for i, id := range ids {
		if vals[i] == nil {
			stale = append(stale, id)
			continue
		}
		var w WorkerInfo
		if err := json.Unmarshal([]byte(*vals[i]), &w); err != nil {
			stale = append(stale, id)
			continue
		}
		out = append(out, w)
	}
	if len(stale) > 0 {
		r.sremMany(r.workersIndex(), stale)
	}
	return out
}

func (r *RedisStore) ListWorkers() []WorkerInfo {
	workers := r.loadLiveWorkers()
	sort.Slice(workers, func(i, j int) bool { return workers[i].WorkerID < workers[j].WorkerID })
	return workers
}

func (r *RedisStore) SelectWorker(mapID string) (WorkerInfo, error) {
	live := r.loadLiveWorkers()
	candidates := make([]WorkerInfo, 0, len(live))
	for _, w := range live {
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
	return candidates[0], nil
}

func (r *RedisStore) AllocateRoomCode(workerID, mapID, mode, visibility string) (RoomInfo, error) {
	var w WorkerInfo
	found, err := r.getJSON(r.workerKey(workerID), &w)
	if err != nil || !found || w.Draining || w.ActiveRooms >= w.MaxRooms {
		return RoomInfo{}, ErrNoHealthyWorker
	}
	roomTTL := r.workerTTL + 5*time.Second
	var room RoomInfo
	allocated := false
	for i := 0; i < 16; i++ {
		cand, err := randomRoomCode(6)
		if err != nil {
			return RoomInfo{}, err
		}
		candidateRoom := RoomInfo{
			Code:       cand,
			MapID:      mapID,
			WorkerID:   workerID,
			Mode:       mode,
			Visibility: visibility,
			Capacity:   10,
			Phase:      "waiting",
			Joinable:   true,
			Scores:     map[string]int{"CT": 0, "T": 0},
			UpdatedAt:  r.now(),
		}
		ok, err := r.setJSONNX(r.roomKey(cand), roomTTL, candidateRoom)
		if err != nil {
			return RoomInfo{}, err
		}
		if ok {
			room = candidateRoom
			allocated = true
			break
		}
	}
	if !allocated {
		return RoomInfo{}, errors.New("failed to allocate unique room code")
	}
	_, _ = r.client.Do("SADD", r.roomsIndex(), room.Code)
	_, _ = r.client.Do("SADD", r.workerRoomsKey(workerID), room.Code)
	w.ActiveRooms++
	_ = r.setJSON(r.workerKey(workerID), r.workerTTL, w)
	return room, nil
}

func (r *RedisStore) GetRoomForJoin(code string) (RoomInfo, WorkerInfo, error) {
	var rm RoomInfo
	ok, err := r.getJSON(r.roomKey(code), &rm)
	if err != nil || !ok {
		return RoomInfo{}, WorkerInfo{}, ErrRoomNotFound
	}
	var w WorkerInfo
	wOk, err := r.getJSON(r.workerKey(rm.WorkerID), &w)
	if err != nil || !wOk {
		return RoomInfo{}, WorkerInfo{}, ErrRoomNotFound
	}
	if w.Draining || !rm.Joinable || rm.Humans >= rm.Capacity || rm.Phase == "ended" {
		return RoomInfo{}, WorkerInfo{}, ErrRoomUnavailable
	}
	return rm, w, nil
}

func (r *RedisStore) ListPublicRooms(mapID string) []RoomInfo {
	codes, err := r.smembers(r.roomsIndex())
	if err != nil || len(codes) == 0 {
		return []RoomInfo{}
	}
	workers := make(map[string]WorkerInfo)
	for _, w := range r.loadLiveWorkers() {
		workers[w.WorkerID] = w
	}
	keys := make([]string, len(codes))
	for i, code := range codes {
		keys[i] = r.roomKey(code)
	}
	vals, err := r.mgetStrings(keys)
	if err != nil {
		return []RoomInfo{}
	}
	out := make([]RoomInfo, 0, len(codes))
	stale := make([]string, 0)
	for i, code := range codes {
		if vals[i] == nil {
			stale = append(stale, code)
			continue
		}
		var rm RoomInfo
		if err := json.Unmarshal([]byte(*vals[i]), &rm); err != nil {
			stale = append(stale, code)
			continue
		}
		w, alive := workers[rm.WorkerID]
		if !alive {
			stale = append(stale, code)
			continue
		}
		if rm.Visibility != "public" || rm.Humans <= 0 {
			continue
		}
		if mapID != "" && rm.MapID != mapID {
			continue
		}
		if w.Draining {
			rm.Joinable = false
		}
		out = append(out, rm)
	}
	if len(stale) > 0 {
		r.sremMany(r.roomsIndex(), stale)
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

func (r *RedisStore) Stats() RegistryStats {
	workers := r.loadLiveWorkers()
	stats := RegistryStats{}
	for _, w := range workers {
		if w.Draining {
			stats.DrainingWorkers++
		} else {
			stats.ActiveWorkers++
		}
	}
	codes, _ := r.smembers(r.roomsIndex())
	if len(codes) == 0 {
		return stats
	}
	keys := make([]string, len(codes))
	for i, code := range codes {
		keys[i] = r.roomKey(code)
	}
	vals, err := r.mgetStrings(keys)
	if err != nil {
		return stats
	}
	stale := make([]string, 0)
	for i, raw := range vals {
		if raw == nil {
			stale = append(stale, codes[i])
			continue
		}
		var rm RoomInfo
		if json.Unmarshal([]byte(*raw), &rm) == nil {
			stats.TotalRooms++
			if rm.Visibility == "public" && rm.Humans > 0 {
				stats.PublicRooms++
			}
		}
	}
	if len(stale) > 0 {
		r.sremMany(r.roomsIndex(), stale)
	}
	return stats
}

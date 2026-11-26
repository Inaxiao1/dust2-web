package store

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeRedisEntry struct {
	val    string
	expire time.Time
}

type fakeRedisServer struct {
	ln   net.Listener
	mu   sync.Mutex
	kv   map[string]fakeRedisEntry
	sets map[string]map[string]struct{}
	pass string
}

func startFakeRedis(t *testing.T, password string) *fakeRedisServer {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen fake redis: %v", err)
	}
	s := &fakeRedisServer{
		ln:   ln,
		kv:   make(map[string]fakeRedisEntry),
		sets: make(map[string]map[string]struct{}),
		pass: password,
	}
	go s.acceptLoop()
	t.Cleanup(func() { _ = ln.Close() })
	return s
}

func (s *fakeRedisServer) addr() string { return s.ln.Addr().String() }

func (s *fakeRedisServer) acceptLoop() {
	for {
		conn, err := s.ln.Accept()
		if err != nil {
			return
		}
		go s.handleConn(conn)
	}
}

func (s *fakeRedisServer) handleConn(conn net.Conn) {
	defer conn.Close()
	r := bufio.NewReader(conn)
	authed := s.pass == ""
	for {
		args, err := readCommand(r)
		if err != nil {
			return
		}
		if len(args) == 0 {
			continue
		}
		cmd := strings.ToUpper(args[0])
		if cmd == "AUTH" {
			if len(args) == 2 && args[1] == s.pass {
				authed = true
				_, _ = io.WriteString(conn, "+OK\r\n")
			} else {
				_, _ = io.WriteString(conn, "-ERR invalid password\r\n")
			}
			continue
		}
		if !authed {
			_, _ = io.WriteString(conn, "-NOAUTH Authentication required\r\n")
			continue
		}
		s.mu.Lock()
		switch cmd {
		case "PING":
			_, _ = io.WriteString(conn, "+PONG\r\n")
		case "SET":
			var exp time.Time
			nx := false
			for i := 3; i < len(args); i++ {
				opt := strings.ToUpper(args[i])
				if opt == "EX" && i+1 < len(args) {
					sec, _ := strconv.Atoi(args[i+1])
					exp = time.Now().Add(time.Duration(sec) * time.Second)
					i++
				} else if opt == "NX" {
					nx = true
				}
			}
			if nx {
				if existing, ok := s.kv[args[1]]; ok && (existing.expire.IsZero() || !time.Now().After(existing.expire)) {
					_, _ = io.WriteString(conn, "$-1\r\n")
					break
				}
			}
			s.kv[args[1]] = fakeRedisEntry{val: args[2], expire: exp}
			_, _ = io.WriteString(conn, "+OK\r\n")
		case "GET":
			entry, ok := s.kv[args[1]]
			if !ok || (!entry.expire.IsZero() && time.Now().After(entry.expire)) {
				delete(s.kv, args[1])
				_, _ = io.WriteString(conn, "$-1\r\n")
			} else {
				_, _ = io.WriteString(conn, fmt.Sprintf("$%d\r\n%s\r\n", len(entry.val), entry.val))
			}
		case "MGET":
			var sb strings.Builder
			sb.WriteString(fmt.Sprintf("*%d\r\n", len(args)-1))
			for _, key := range args[1:] {
				entry, ok := s.kv[key]
				if !ok || (!entry.expire.IsZero() && time.Now().After(entry.expire)) {
					delete(s.kv, key)
					sb.WriteString("$-1\r\n")
				} else {
					sb.WriteString(fmt.Sprintf("$%d\r\n%s\r\n", len(entry.val), entry.val))
				}
			}
			_, _ = io.WriteString(conn, sb.String())
		case "DEL":
			delete(s.kv, args[1])
			_, _ = io.WriteString(conn, ":1\r\n")
		case "SADD":
			if s.sets[args[1]] == nil {
				s.sets[args[1]] = make(map[string]struct{})
			}
			for _, m := range args[2:] {
				s.sets[args[1]][m] = struct{}{}
			}
			_, _ = io.WriteString(conn, ":1\r\n")
		case "SREM":
			if s.sets[args[1]] != nil {
				for _, m := range args[2:] {
					delete(s.sets[args[1]], m)
				}
			}
			_, _ = io.WriteString(conn, ":1\r\n")
		case "SMEMBERS":
			members := s.sets[args[1]]
			var sb strings.Builder
			sb.WriteString(fmt.Sprintf("*%d\r\n", len(members)))
			for m := range members {
				sb.WriteString(fmt.Sprintf("$%d\r\n%s\r\n", len(m), m))
			}
			_, _ = io.WriteString(conn, sb.String())
		default:
			_, _ = io.WriteString(conn, "-ERR unsupported command\r\n")
		}
		s.mu.Unlock()
	}
}

func readCommand(r *bufio.Reader) ([]string, error) {
	header, err := r.ReadString('\n')
	if err != nil {
		return nil, err
	}
	header = strings.TrimSpace(header)
	if !strings.HasPrefix(header, "*") {
		return nil, fmt.Errorf("expected array header, got %q", header)
	}
	n, err := strconv.Atoi(header[1:])
	if err != nil {
		return nil, err
	}
	args := make([]string, 0, n)
	for i := 0; i < n; i++ {
		lenLine, err := r.ReadString('\n')
		if err != nil {
			return nil, err
		}
		l, err := strconv.Atoi(strings.TrimPrefix(strings.TrimSpace(lenLine), "$"))
		if err != nil {
			return nil, err
		}
		buf := make([]byte, l+2)
		if _, err := io.ReadFull(r, buf); err != nil {
			return nil, err
		}
		args = append(args, string(buf[:l]))
	}
	return args, nil
}

func TestRedisStoreMultiReplicaSharingAndDrain(t *testing.T) {
	srv := startFakeRedis(t, "redis-pass-123")

	replicaA, err := NewRedisStore(RedisConfig{
		Addr:      srv.addr(),
		Password:  "redis-pass-123",
		KeyPrefix: "cs2test",
		WorkerTTL: 15 * time.Second,
	}, time.Now)
	if err != nil {
		t.Fatalf("replicaA: %v", err)
	}
	defer replicaA.Close()

	replicaB, err := NewRedisStore(RedisConfig{
		Addr:      srv.addr(),
		Password:  "redis-pass-123",
		KeyPrefix: "cs2test",
		WorkerTTL: 15 * time.Second,
	}, time.Now)
	if err != nil {
		t.Fatalf("replicaB: %v", err)
	}
	defer replicaB.Close()

	// Replica A registers worker; Replica B immediately sees and schedules it.
	if err := replicaA.RegisterWorker(WorkerInfo{
		WorkerID: "w-redis-1",
		WsURL:    "wss://node-r1.example.com/ws",
		Maps:     []string{"de_mirage"},
		MaxRooms: 4,
	}); err != nil {
		t.Fatalf("RegisterWorker: %v", err)
	}

	selected, err := replicaB.SelectWorker("de_mirage")
	if err != nil || selected.WorkerID != "w-redis-1" {
		t.Fatalf("replicaB SelectWorker failed: err=%v worker=%+v", err, selected)
	}

	if err := replicaA.Heartbeat(WorkerHeartbeat{
		WorkerID:  "w-redis-1",
		TickP99Ms: 3.1,
		Rooms: []RoomInfo{{
			Code: "RDS123", MapID: "de_mirage", Mode: "defuse", Visibility: "public",
			Humans: 2, Bots: 8, Capacity: 10, Phase: "live", Joinable: true,
		}},
	}); err != nil {
		t.Fatalf("Heartbeat: %v", err)
	}

	rooms := replicaB.ListPublicRooms("de_mirage")
	if len(rooms) != 1 || rooms[0].Code != "RDS123" || !rooms[0].Joinable {
		t.Fatalf("unexpected rooms on replicaB: %+v", rooms)
	}

	// Replica B marks worker draining; Replica A sees room unjoinable & rejects joins.
	if _, err := replicaB.MarkDraining("w-redis-1"); err != nil {
		t.Fatalf("MarkDraining: %v", err)
	}
	if _, _, err := replicaA.GetRoomForJoin("RDS123"); err != ErrRoomUnavailable {
		t.Fatalf("expected ErrRoomUnavailable after drain, got %v", err)
	}
	if _, err := replicaA.SelectWorker("de_mirage"); err != ErrNoHealthyWorker {
		t.Fatalf("expected ErrNoHealthyWorker after drain, got %v", err)
	}
}

func TestRedisStoreClosedRoomPruningAndConcurrentPool(t *testing.T) {
	srv := startFakeRedis(t, "")
	clock := time.Unix(1700000000, 0)
	var clockMu sync.Mutex
	nowFn := func() time.Time {
		clockMu.Lock()
		defer clockMu.Unlock()
		return clock
	}

	rs, err := NewRedisStore(RedisConfig{
		Addr:      srv.addr(),
		KeyPrefix: "cs2prune",
		WorkerTTL: 30 * time.Second,
		PoolSize:  8,
	}, nowFn)
	if err != nil {
		t.Fatalf("NewRedisStore: %v", err)
	}
	defer rs.Close()

	if err := rs.RegisterWorker(WorkerInfo{
		WorkerID: "w-1",
		WsURL:    "wss://w1.example.com/ws",
		Maps:     []string{"de_dust2"},
		MaxRooms: 12,
	}); err != nil {
		t.Fatalf("RegisterWorker: %v", err)
	}

	// Concurrent room allocations across pooled connections must produce unique codes.
	var wg sync.WaitGroup
	codes := make(chan string, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rm, err := rs.AllocateRoomCode("w-1", "de_dust2", "defuse", "public")
			if err == nil {
				codes <- rm.Code
			}
		}()
	}
	wg.Wait()
	close(codes)
	seen := make(map[string]struct{})
	for c := range codes {
		if _, dup := seen[c]; dup {
			t.Fatalf("duplicate room code allocated concurrently: %s", c)
		}
		seen[c] = struct{}{}
	}
	if len(seen) != 8 {
		t.Fatalf("expected 8 allocated rooms, got %d", len(seen))
	}

	// Report one live room; after grace period (>10s), unpicked rooms must be pruned by Heartbeat.
	if err := rs.Heartbeat(WorkerHeartbeat{
		WorkerID: "w-1",
		Rooms: []RoomInfo{{
			Code: "LIVE01", MapID: "de_dust2", Mode: "defuse", Visibility: "public",
			Humans: 2, Bots: 4, Capacity: 10, Phase: "live", Joinable: true, Players: []string{"Alpha", "Bravo"},
		}},
	}); err != nil {
		t.Fatalf("Heartbeat 1: %v", err)
	}
	clockMu.Lock()
	clock = clock.Add(12 * time.Second)
	clockMu.Unlock()

	// Next heartbeat reports 0 rooms -> LIVE01 and expired allocations are cleaned immediately.
	if err := rs.Heartbeat(WorkerHeartbeat{WorkerID: "w-1", Rooms: nil}); err != nil {
		t.Fatalf("Heartbeat 2: %v", err)
	}
	if _, _, err := rs.GetRoomForJoin("LIVE01"); err != ErrRoomNotFound {
		t.Fatalf("expected closed room LIVE01 pruned, got %v", err)
	}
	if rooms := rs.ListPublicRooms("de_dust2"); len(rooms) != 0 {
		t.Fatalf("expected 0 public rooms after prune, got %+v", rooms)
	}
}

package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/duskrain/cs2-control-plane/internal/api"
	"github.com/duskrain/cs2-control-plane/internal/store"
	"github.com/duskrain/cs2-control-plane/internal/token"
)

func main() {
	host := envOr("HOST", "127.0.0.1")
	port := envOr("PORT", "8080")
	addr := host + ":" + port

	prod := os.Getenv("CONTROL_PLANE_ENV") == "production"
	joinSecret := os.Getenv("JOIN_TOKEN_SECRET")
	workerToken := os.Getenv("WORKER_AUTH_TOKEN")
	if prod && (len(joinSecret) < 16 || len(workerToken) < 16) {
		log.Fatal("JOIN_TOKEN_SECRET and WORKER_AUTH_TOKEN (>=16 chars) are required in production")
	}
	if joinSecret == "" {
		joinSecret = randomHex(24)
		log.Printf("DEV WARNING: generated ephemeral JOIN_TOKEN_SECRET")
	}
	if workerToken == "" {
		workerToken = randomHex(24)
		log.Printf("DEV WARNING: generated ephemeral WORKER_AUTH_TOKEN")
	}

	ttlSec := 15
	if raw := os.Getenv("WORKER_TTL_SECONDS"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			ttlSec = parsed
		}
	}

	signer, err := token.NewSigner([]byte(joinSecret), time.Now)
	if err != nil {
		log.Fatalf("init token signer: %v", err)
	}

	var reg store.RegistryStore
	if redisAddr := os.Getenv("REDIS_ADDR"); redisAddr != "" {
		rs, err := store.NewRedisStore(store.RedisConfig{
			Addr:      redisAddr,
			Password:  os.Getenv("REDIS_PASSWORD"),
			KeyPrefix: envOr("REDIS_KEY_PREFIX", "cs2"),
			WorkerTTL: time.Duration(ttlSec) * time.Second,
		}, time.Now)
		if err != nil {
			log.Fatalf("init redis store: %v", err)
		}
		defer rs.Close()
		reg = rs
		log.Printf("control-plane using RedisStore (%s)", redisAddr)
	} else {
		reg = store.NewMemoryStore(time.Duration(ttlSec)*time.Second, time.Now)
		log.Printf("control-plane using MemoryStore (set REDIS_ADDR for multi-replica HA)")
	}

	var allowed []string
	if raw := os.Getenv("ALLOWED_ORIGINS"); raw != "" {
		allowed = strings.Split(raw, ",")
	}
	ratePerMin := 60
	if raw := os.Getenv("RATE_LIMIT_PER_MIN"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil {
			ratePerMin = parsed
		}
	}
	rateBurst := 20
	if raw := os.Getenv("RATE_LIMIT_BURST"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			rateBurst = parsed
		}
	}
	srvAPI, err := api.NewServer(api.Config{
		Store:           reg,
		Signer:          signer,
		WorkerAuthToken: workerToken,
		AllowedOrigins:  allowed,
		TokenTTL:        60 * time.Second,
		RateLimitPerMin: ratePerMin,
		RateLimitBurst:  rateBurst,
	})
	if err != nil {
		log.Fatalf("init api server: %v", err)
	}

	httpServer := &http.Server{
		Addr:              addr,
		Handler:           srvAPI,
		ReadHeaderTimeout: 5 * time.Second,
	}

	sigUsr := make(chan os.Signal, 1)
	signal.Notify(sigUsr, syscall.SIGUSR2)
	go func() {
		for range sigUsr {
			srvAPI.BeginDrain()
			log.Printf("control-plane entering drain mode")
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	ln, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatalf("listen: %v", err)
	}
	tcpAddr := ln.Addr().(*net.TCPAddr)
	readyPayload, _ := json.Marshal(map[string]any{
		"service": "cs2-control-plane",
		"port":    tcpAddr.Port,
		"addr":    tcpAddr.String(),
	})
	os.Stdout.Write(append(readyPayload, '\n'))

	go func() {
		log.Printf("cs2-control-plane listening on http://%s", tcpAddr.String())
		if err := httpServer.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("serve: %v", err)
		}
	}()

	<-stop
	srvAPI.BeginDrain()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = httpServer.Shutdown(ctx)
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

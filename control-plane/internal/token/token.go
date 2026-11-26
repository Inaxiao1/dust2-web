package token

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

const prefix = "v2."

var (
	ErrInvalidFormat = errors.New("invalid join token format")
	ErrInvalidSig    = errors.New("invalid join token signature")
	ErrExpired       = errors.New("join token expired")
)

type Claims struct {
	JTI        string `json:"jti"`
	RoomCode   string `json:"roomCode"`
	MapID      string `json:"mapId"`
	WorkerID   string `json:"workerId"`
	Action     string `json:"action"`
	Mode       string `json:"mode"`
	Visibility string `json:"visibility"`
	PlayerName string `json:"playerName"`
	PlayerUID  string `json:"playerUid,omitempty"`
	IssuedAt   int64  `json:"iat"`
	ExpiresAt  int64  `json:"exp"`
}

type Signer struct {
	secret []byte
	now    func() time.Time
}

func NewSigner(secret []byte, now func() time.Time) (*Signer, error) {
	if len(secret) < 16 {
		return nil, errors.New("join token secret must be at least 16 bytes")
	}
	if now == nil {
		now = time.Now
	}
	copied := make([]byte, len(secret))
	copy(copied, secret)
	return &Signer{secret: copied, now: now}, nil
}

func (s *Signer) Sign(claims Claims, ttl time.Duration) (string, Claims, error) {
	if claims.JTI == "" {
		var buf [12]byte
		if _, err := rand.Read(buf[:]); err != nil {
			return "", Claims{}, err
		}
		claims.JTI = hex.EncodeToString(buf[:])
	}
	nowUnix := s.now().Unix()
	if claims.IssuedAt == 0 {
		claims.IssuedAt = nowUnix
	}
	if claims.ExpiresAt == 0 {
		claims.ExpiresAt = claims.IssuedAt + int64(ttl.Seconds())
	}
	raw, err := json.Marshal(claims)
	if err != nil {
		return "", Claims{}, err
	}
	payloadB64 := base64.RawURLEncoding.EncodeToString(raw)
	unsigned := prefix + payloadB64
	sig := s.computeMAC(unsigned)
	return unsigned + "." + base64.RawURLEncoding.EncodeToString(sig), claims, nil
}

func (s *Signer) Verify(token string) (Claims, error) {
	if !strings.HasPrefix(token, prefix) {
		return Claims{}, ErrInvalidFormat
	}
	rest := token[len(prefix):]
	dot := strings.IndexByte(rest, '.')
	if dot <= 0 || dot == len(rest)-1 {
		return Claims{}, ErrInvalidFormat
	}
	payloadB64 := rest[:dot]
	sigB64 := rest[dot+1:]
	if strings.ContainsRune(sigB64, '.') {
		return Claims{}, ErrInvalidFormat
	}

	gotSig, err := base64.RawURLEncoding.DecodeString(sigB64)
	if err != nil {
		return Claims{}, ErrInvalidFormat
	}
	expectedSig := s.computeMAC(prefix + payloadB64)
	if !hmac.Equal(gotSig, expectedSig) {
		return Claims{}, ErrInvalidSig
	}

	raw, err := base64.RawURLEncoding.DecodeString(payloadB64)
	if err != nil {
		return Claims{}, ErrInvalidFormat
	}
	var claims Claims
	if err := json.Unmarshal(raw, &claims); err != nil {
		return Claims{}, ErrInvalidFormat
	}
	if s.now().Unix() > claims.ExpiresAt {
		return Claims{}, ErrExpired
	}
	return claims, nil
}

func (s *Signer) computeMAC(data string) []byte {
	mac := hmac.New(sha256.New, s.secret)
	mac.Write([]byte(data))
	return mac.Sum(nil)
}

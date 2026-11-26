package token

import (
	"testing"
	"time"
)

func TestSignAndVerify(t *testing.T) {
	now := time.Unix(1700000000, 0)
	signer, err := NewSigner([]byte("super-secret-signing-key-32bytes"), func() time.Time { return now })
	if err != nil {
		t.Fatalf("NewSigner: %v", err)
	}

	signed, claims, err := signer.Sign(Claims{
		RoomCode:   "AB12CD",
		MapID:      "de_mirage",
		WorkerID:   "w-mirage-1",
		Action:     "create",
		Mode:       "defuse",
		Visibility: "public",
		PlayerName: "Alice",
	}, 60*time.Second)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	if claims.ExpiresAt != now.Unix()+60 {
		t.Fatalf("unexpected exp: %d", claims.ExpiresAt)
	}

	got, err := signer.Verify(signed)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got.RoomCode != "AB12CD" || got.WorkerID != "w-mirage-1" || got.MapID != "de_mirage" {
		t.Fatalf("unexpected claims: %+v", got)
	}

	// Tampering signature or payload fails.
	tampered := signed[:len(signed)-1] + "X"
	if _, err := signer.Verify(tampered); err == nil {
		t.Fatal("expected tampered token to fail")
	}

	// Expired token fails.
	now = now.Add(61 * time.Second)
	if _, err := signer.Verify(signed); err != ErrExpired {
		t.Fatalf("expected ErrExpired, got %v", err)
	}
}

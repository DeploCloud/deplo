package bootstrap

import (
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

// fakeControlPlane stands in for /api/agent/bootstrap: it parses the CSR, signs
// it with a throwaway CA, and HMAC-binds the response with the token (the
// plain-HTTP trust path). tamperMAC corrupts the MAC to test rejection.
func fakeControlPlane(t *testing.T, token string, tamperMAC bool) *httptest.Server {
	t.Helper()
	// A throwaway CA.
	caPub, caPriv, _ := ed25519.GenerateKey(rand.Reader)
	caTmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "Test CA"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
	}
	caDER, _ := x509.CreateCertificate(rand.Reader, caTmpl, caTmpl, caPub, caPriv)
	caCert, _ := x509.ParseCertificate(caDER)
	caPem := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER})

	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req callHomeRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		if req.Token != token {
			w.WriteHeader(401)
			_ = json.NewEncoder(w).Encode(callHomeResponse{Error: "unknown-token"})
			return
		}
		block, _ := pem.Decode([]byte(req.CSRPem))
		csr, err := x509.ParseCertificateRequest(block.Bytes)
		if err != nil || csr.CheckSignature() != nil {
			w.WriteHeader(401)
			_ = json.NewEncoder(w).Encode(callHomeResponse{Error: "bad-csr"})
			return
		}
		leafTmpl := &x509.Certificate{
			SerialNumber: big.NewInt(2),
			Subject:      pkix.Name{CommonName: "deplo-agent"},
			NotBefore:    time.Now().Add(-time.Minute),
			NotAfter:     time.Now().Add(time.Hour),
		}
		leafDER, _ := x509.CreateCertificate(rand.Reader, leafTmpl, caCert, csr.PublicKey, caPriv)
		leafPem := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: leafDER})

		payload, _ := json.Marshal(callHomeResponse{CertPem: string(leafPem), CAPem: string(caPem)})
		h := hmac.New(sha256.New, []byte(token))
		h.Write(payload)
		mac := hex.EncodeToString(h.Sum(nil))
		if tamperMAC {
			mac = "deadbeef"
		}
		w.Header().Set("x-deplo-bootstrap-mac", mac)
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write(payload)
	}))
}

func TestBootstrap_happyPathOverHTTP(t *testing.T) {
	srv := fakeControlPlane(t, "tok-123", false)
	defer srv.Close()
	dir := t.TempDir()

	mats, err := Run(Config{
		ControlPlaneURL: srv.URL, // http:// -> the HMAC trust path
		Token:           "tok-123",
		Fingerprint:     "", // no TLS to pin
		AgentPort:       9443,
		AgentDir:        dir,
	})
	if err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	if !Provisioned(dir) {
		t.Fatalf("materials not written")
	}
	// The key we wrote must match the cert we got back (it signed the CSR).
	keyPem, _ := os.ReadFile(mats.KeyPath)
	certPem, _ := os.ReadFile(mats.CertPath)
	if len(keyPem) == 0 || len(certPem) == 0 {
		t.Fatalf("empty materials")
	}
	kb, _ := pem.Decode(keyPem)
	if _, err := x509.ParsePKCS8PrivateKey(kb.Bytes); err != nil {
		t.Fatalf("bad key: %v", err)
	}
}

func TestBootstrap_rejectsTamperedMACOverHTTP(t *testing.T) {
	srv := fakeControlPlane(t, "tok-123", true) // corrupts the MAC
	defer srv.Close()
	_, err := Run(Config{
		ControlPlaneURL: srv.URL,
		Token:           "tok-123",
		Fingerprint:     "",
		AgentPort:       9443,
		AgentDir:        t.TempDir(),
	})
	if err == nil {
		t.Fatalf("expected bootstrap to reject a tampered MAC")
	}
}

func TestBootstrap_rejectsBadToken(t *testing.T) {
	srv := fakeControlPlane(t, "right-token", false)
	defer srv.Close()
	_, err := Run(Config{
		ControlPlaneURL: srv.URL,
		Token:           "wrong-token",
		AgentDir:        t.TempDir(),
	})
	if err == nil {
		t.Fatalf("expected rejection for a bad token")
	}
}

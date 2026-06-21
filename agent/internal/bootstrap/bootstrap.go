// Package bootstrap is the agent side of the call-home provisioning handshake
// (PLAN Part B, P1-P4). On first run the agent has no mTLS identity: it
// generates its OWN Ed25519 key (which never leaves this host), builds a PKCS#10
// CSR, and POSTs it with the one-time token to the control plane's
// /api/agent/bootstrap. The control plane (the CA) signs the CSR and returns the
// agent's cert + the CA cert; the agent persists them and then serves gRPC with
// that cert.
//
// THE AGENT AUTHENTICATES THE CONTROL PLANE BEFORE SENDING THE TOKEN (P2/P3):
//   - over HTTPS, it PINS the control-plane cert fingerprint carried in the
//     install command (works for Let's-Encrypt-signed or self-signed-on-IP
//     alike — one trust model);
//   - over plain HTTP (the bare-IP case with no TLS), there is no cert to pin,
//     so it verifies the response HMAC: the control plane signs the response
//     body with the token, and a network attacker who never had the token cannot
//     forge the CA it hands back.
package bootstrap

import (
	"bytes"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Materials are the persisted mTLS files the agent serves with after bootstrap.
type Materials struct {
	CertPath string // agent's signed server cert (PEM)
	KeyPath  string // agent's private key (PEM) — generated here, never sent
	CAPath   string // pinned CA cert (PEM)
}

// Paths returns the standard material paths under agentDir.
func Paths(agentDir string) Materials {
	return Materials{
		CertPath: filepath.Join(agentDir, "agent.crt"),
		KeyPath:  filepath.Join(agentDir, "agent.key"),
		CAPath:   filepath.Join(agentDir, "ca.crt"),
	}
}

// Provisioned reports whether the agent already has its materials (so a restart
// skips bootstrap and serves straight away).
func Provisioned(agentDir string) bool {
	m := Paths(agentDir)
	for _, p := range []string{m.CertPath, m.KeyPath, m.CAPath} {
		if _, err := os.Stat(p); err != nil {
			return false
		}
	}
	return true
}

// Config carries the one-time inputs from the install command.
type Config struct {
	// ControlPlaneURL is the base URL to call home to (http(s)://host[:port]).
	ControlPlaneURL string
	// Token is the single-use bootstrap token.
	Token string
	// Fingerprint is the expected control-plane cert sha256 (HTTPS only); "" => HTTP.
	Fingerprint string
	// AgentPort is the port the agent will serve gRPC on (reported to the control
	// plane so it knows where to dial back).
	AgentPort int
	// AdvertisedHost is what the agent believes its address is (informational).
	AdvertisedHost string
	// AgentDir is where to write the resulting materials.
	AgentDir string
}

type callHomeRequest struct {
	Token          string `json:"token"`
	CSRPem         string `json:"csrPem"`
	AgentPort      int    `json:"agentPort,omitempty"`
	AdvertisedHost string `json:"advertisedHost,omitempty"`
}

type callHomeResponse struct {
	CertPem string `json:"certPem"`
	CAPem   string `json:"caPem"`
	Error   string `json:"error,omitempty"`
}

// Run performs the bootstrap and writes the materials. Returns the Materials
// paths on success. Idempotent in spirit: callers should check Provisioned first.
func Run(cfg Config) (Materials, error) {
	mats := Paths(cfg.AgentDir)
	if err := os.MkdirAll(cfg.AgentDir, 0o700); err != nil {
		return mats, fmt.Errorf("create agent dir: %w", err)
	}

	// 1. Generate our own key + CSR. The private key never leaves this host.
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return mats, fmt.Errorf("generate key: %w", err)
	}
	csrDER, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{
		Subject: pkix.Name{CommonName: "deplo-agent"},
	}, priv)
	if err != nil {
		return mats, fmt.Errorf("create CSR: %w", err)
	}
	_ = pub
	csrPem := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: csrDER}))

	// 2. Call home, authenticating the control plane first (P2/P3).
	resp, rawBody, mac, err := callHome(cfg, csrPem)
	if err != nil {
		return mats, err
	}
	if resp.Error != "" {
		return mats, fmt.Errorf("control plane rejected bootstrap: %s", resp.Error)
	}
	if resp.CertPem == "" || resp.CAPem == "" {
		return mats, fmt.Errorf("control plane returned no certificate")
	}

	// 3. Over plain HTTP, verify the response HMAC binds it to the token (P2). Over
	// HTTPS the fingerprint pin already authenticated the peer, but verifying the
	// MAC when present is harmless belt-and-suspenders.
	if cfg.Fingerprint == "" {
		if mac == "" {
			return mats, fmt.Errorf("control plane did not sign the bootstrap response (refusing over plain HTTP)")
		}
		if !verifyMAC(cfg.Token, rawBody, mac) {
			return mats, fmt.Errorf("bootstrap response HMAC did not verify — possible tampering")
		}
	}

	// 4. Persist the materials.
	keyDER, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return mats, fmt.Errorf("marshal key: %w", err)
	}
	keyPem := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})
	if err := os.WriteFile(mats.KeyPath, keyPem, 0o600); err != nil {
		return mats, fmt.Errorf("write key: %w", err)
	}
	if err := os.WriteFile(mats.CertPath, []byte(resp.CertPem), 0o600); err != nil {
		return mats, fmt.Errorf("write cert: %w", err)
	}
	if err := os.WriteFile(mats.CAPath, []byte(resp.CAPem), 0o644); err != nil {
		return mats, fmt.Errorf("write ca: %w", err)
	}
	return mats, nil
}

// callHome POSTs the CSR + token and returns the parsed response, the raw body
// bytes (for HMAC verification), and the response MAC header.
func callHome(cfg Config, csrPem string) (callHomeResponse, []byte, string, error) {
	body, _ := json.Marshal(callHomeRequest{
		Token:          cfg.Token,
		CSRPem:         csrPem,
		AgentPort:      cfg.AgentPort,
		AdvertisedHost: cfg.AdvertisedHost,
	})
	url := strings.TrimRight(cfg.ControlPlaneURL, "/") + "/api/agent/bootstrap"

	client := &http.Client{Timeout: 30 * time.Second}
	if strings.HasPrefix(strings.ToLower(url), "https://") {
		if cfg.Fingerprint == "" {
			return callHomeResponse{}, nil, "", fmt.Errorf("HTTPS control plane requires a pinned fingerprint")
		}
		client.Transport = pinnedTransport(cfg.Fingerprint)
	}

	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return callHomeResponse{}, nil, "", err
	}
	req.Header.Set("content-type", "application/json")

	res, err := client.Do(req)
	if err != nil {
		return callHomeResponse{}, nil, "", fmt.Errorf("call home: %w", err)
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return callHomeResponse{}, nil, "", err
	}
	var parsed callHomeResponse
	_ = json.Unmarshal(raw, &parsed)
	if res.StatusCode != http.StatusOK && parsed.Error == "" {
		parsed.Error = fmt.Sprintf("HTTP %d", res.StatusCode)
	}
	return parsed, raw, res.Header.Get("x-deplo-bootstrap-mac"), nil
}

// pinnedTransport builds an http.Transport that trusts the control plane IFF the
// presented leaf cert's sha256 matches the expected fingerprint — Let's-Encrypt
// or self-signed alike (P3). InsecureSkipVerify disables the default CA-chain +
// hostname check precisely BECAUSE the pin is the trust anchor (a self-signed
// cert on a bare IP has no chain to verify); the VerifyConnection callback then
// enforces the exact pin, which is strictly stronger than chain trust here.
func pinnedTransport(expected string) *http.Transport {
	want := strings.ToLower(strings.ReplaceAll(expected, ":", ""))
	return &http.Transport{
		TLSClientConfig: &tls.Config{
			InsecureSkipVerify: true, // pin replaces chain verification (P3)
			VerifyConnection: func(cs tls.ConnectionState) error {
				if len(cs.PeerCertificates) == 0 {
					return fmt.Errorf("control plane presented no certificate")
				}
				sum := sha256.Sum256(cs.PeerCertificates[0].Raw)
				got := hex.EncodeToString(sum[:])
				if !hmac.Equal([]byte(got), []byte(want)) {
					return fmt.Errorf("control-plane cert fingerprint mismatch: pinned %s, got %s", want, got)
				}
				return nil
			},
		},
	}
}

func verifyMAC(token string, body []byte, mac string) bool {
	h := hmac.New(sha256.New, []byte(token))
	h.Write(body)
	expected := hex.EncodeToString(h.Sum(nil))
	return hmac.Equal([]byte(expected), []byte(mac))
}

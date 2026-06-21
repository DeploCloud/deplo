// Command deplo-agent is the per-server agent: a single static Go binary that
// owns the host-coupled half of the Deplo platform (Docker, the build pipeline,
// host metrics) on the machine it runs on, exposed to the control plane over a
// typed, mTLS-secured gRPC contract (proto/agent.proto, ADR-0006). No Node, no
// Deplo app on the target — one scp-able artifact runnable on a bare Linux host
// with Docker installed.
//
// PART A: it serves a LOCAL agent on the Deplo host (the control plane dials its
// own machine). Remote provisioning + the call-home bootstrap are Part B.
//
// mTLS from day one (decided with the user): the agent presents a CA-signed
// server cert, requires a CA-signed client cert from the control plane, and
// pins the same CA — the CA being the control plane, whose key is derived from
// DEPLO_SECRET. The control plane writes the agent's cert/key + the CA cert to
// the paths below before dialing.
package main

import (
	"crypto/tls"
	"crypto/x509"
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"strings"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"

	pb "github.com/idradev/deplo/agent/gen"
	"github.com/idradev/deplo/agent/internal/bootstrap"
	"github.com/idradev/deplo/agent/internal/server"
)

func main() {
	var (
		addr        = flag.String("addr", "127.0.0.1:9443", "listen address (host:port)")
		certFile    = flag.String("cert", envOr("DEPLO_AGENT_CERT", ""), "agent server certificate (PEM)")
		keyFile     = flag.String("key", envOr("DEPLO_AGENT_KEY", ""), "agent server private key (PEM)")
		caFile      = flag.String("ca", envOr("DEPLO_AGENT_CA", ""), "CA certificate to verify the control plane (PEM)")
		agentDir    = flag.String("agent-dir", envOr("DEPLO_AGENT_DIR", ""), "directory holding mTLS materials (bootstrap writes them here)")
		stackDir    = flag.String("stack-dir", envOr("DEPLO_AGENT_STACK_DIR", "/data/stacks"), "where rendered stack files are written")
		buildTmpDir = flag.String("build-tmp", envOr("DEPLO_AGENT_BUILD_TMP", os.TempDir()), "where upload build contexts are extracted")
		dataDir     = flag.String("data-dir", envOr("DEPLO_AGENT_DATA_DIR", "/"), "filesystem measured for disk metrics")
		insecure    = flag.Bool("insecure", os.Getenv("DEPLO_AGENT_INSECURE") == "1", "DANGEROUS: serve without mTLS (tests/local only)")

		// Call-home bootstrap (PLAN Part B). Set by the install command on a remote
		// server's first run; ignored once the agent is already provisioned.
		bootstrapURL   = flag.String("bootstrap-url", envOr("DEPLO_BOOTSTRAP_URL", ""), "control-plane URL to call home to on first run")
		bootstrapTok   = flag.String("bootstrap-token", envOr("DEPLO_BOOTSTRAP_TOKEN", ""), "one-time bootstrap token")
		bootstrapFP    = flag.String("bootstrap-fingerprint", envOr("DEPLO_BOOTSTRAP_FINGERPRINT", ""), "expected control-plane cert sha256 (HTTPS only)")
		advertisedHost = flag.String("advertised-host", envOr("DEPLO_AGENT_ADVERTISED_HOST", ""), "address the agent reports it is reachable at (informational)")
	)
	flag.Parse()

	if err := os.MkdirAll(*buildTmpDir, 0o755); err != nil {
		log.Fatalf("deplo-agent: build-tmp: %v", err)
	}

	// Resolve the mTLS material paths. Explicit --cert/--key/--ca (the supervised
	// LOCAL agent, Part A) take precedence; otherwise, with --agent-dir, the
	// materials live there and may be produced by a call-home bootstrap (Part B).
	cert, key, ca := *certFile, *keyFile, *caFile
	if cert == "" && key == "" && ca == "" && *agentDir != "" {
		m := bootstrap.Paths(*agentDir)
		if !bootstrap.Provisioned(*agentDir) {
			// First run on a remote server: call home to get our cert signed.
			if *bootstrapTok == "" || *bootstrapURL == "" {
				log.Fatalf("deplo-agent: not provisioned and no bootstrap token/url given (run via the dashboard's install command)")
			}
			port := portFromAddr(*addr)
			log.Printf("deplo-agent: bootstrapping against %s", *bootstrapURL)
			if _, err := bootstrap.Run(bootstrap.Config{
				ControlPlaneURL: *bootstrapURL,
				Token:           *bootstrapTok,
				Fingerprint:     *bootstrapFP,
				AgentPort:       port,
				AdvertisedHost:  *advertisedHost,
				AgentDir:        *agentDir,
			}); err != nil {
				log.Fatalf("deplo-agent: bootstrap failed: %v", err)
			}
			log.Printf("deplo-agent: bootstrap complete; materials in %s", *agentDir)
		}
		cert, key, ca = m.CertPath, m.KeyPath, m.CAPath
	}

	var opts []grpc.ServerOption
	if !*insecure {
		creds, err := loadMTLS(cert, key, ca)
		if err != nil {
			log.Fatalf("deplo-agent: mTLS setup: %v", err)
		}
		opts = append(opts, grpc.Creds(creds))
	} else {
		log.Printf("deplo-agent: WARNING serving WITHOUT mTLS (--insecure)")
	}
	// Build contexts and rendered compose can be large; lift the default 4MiB
	// receive cap so an uploaded archive rides inside the Deploy request.
	opts = append(opts, grpc.MaxRecvMsgSize(256*1024*1024))

	srv := grpc.NewServer(opts...)
	pb.RegisterAgentServer(srv, server.New(*stackDir, *buildTmpDir, *dataDir))

	lis, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatalf("deplo-agent: listen %s: %v", *addr, err)
	}
	log.Printf("deplo-agent %s listening on %s (mtls=%v)", server.AgentVersion, *addr, !*insecure)
	if err := srv.Serve(lis); err != nil {
		log.Fatalf("deplo-agent: serve: %v", err)
	}
}

// loadMTLS builds server transport credentials that present the agent's cert
// and REQUIRE a CA-signed client cert (the control plane). A peer that cannot
// present such a cert never completes the handshake.
func loadMTLS(certFile, keyFile, caFile string) (credentials.TransportCredentials, error) {
	if certFile == "" || keyFile == "" || caFile == "" {
		return nil, fmt.Errorf("cert, key and ca are all required for mTLS (or pass --insecure for local tests)")
	}
	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, fmt.Errorf("load keypair: %w", err)
	}
	caPem, err := os.ReadFile(caFile)
	if err != nil {
		return nil, fmt.Errorf("read ca: %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPem) {
		return nil, fmt.Errorf("ca file %q contained no certificates", caFile)
	}
	return credentials.NewTLS(&tls.Config{
		Certificates: []tls.Certificate{cert},
		ClientAuth:   tls.RequireAndVerifyClientCert,
		ClientCAs:    pool,
		MinVersion:   tls.VersionTLS12,
	}), nil
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// portFromAddr extracts the port from a host:port listen address, defaulting to
// 9443. Reported to the control plane at bootstrap so it knows where to dial.
func portFromAddr(addr string) int {
	_, p, err := net.SplitHostPort(addr)
	if err != nil {
		return 9443
	}
	port := 0
	for _, c := range strings.TrimSpace(p) {
		if c < '0' || c > '9' {
			return 9443
		}
		port = port*10 + int(c-'0')
	}
	if port == 0 {
		return 9443
	}
	return port
}

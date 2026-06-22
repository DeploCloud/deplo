# The Deplo server agent (PLAN Part A / ADR-0006). A single static Go binary,
# one per server, that owns the host-coupled half of the platform over mTLS gRPC.
#
#   make build     -> ./bin/deplo-agent (static, this platform)
#   make proto     -> regenerate Go + TS stubs from ../proto/agent.proto
#   make test      -> go test ./...
#   make vet       -> go vet ./...

# Stamp the agent version from version.json — the SINGLE source the control plane
# also reads (lib/version.ts EXPECTED_AGENT_VERSION), so the binary's version and
# the control plane's "latest" can't drift. Extracted with sed (portable); falls
# back to "dev" if the file/field is missing. Override with `make build VERSION=x`.
VERSION ?= $(shell sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' version.json 2>/dev/null || echo dev)
LDFLAGS := -X github.com/idradev/deplo/agent/internal/server.AgentVersion=$(VERSION)

.PHONY: build test vet proto clean

build:
	CGO_ENABLED=0 go build -ldflags "$(LDFLAGS)" -o bin/deplo-agent .

test:
	go test ./...

vet:
	go vet ./...

# Regenerate BOTH sides of the contract (Go agent + TS control-plane client).
proto:
	bash ../proto/generate.sh

clean:
	rm -rf bin

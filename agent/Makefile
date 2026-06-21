# The Deplo server agent (PLAN Part A / ADR-0006). A single static Go binary,
# one per server, that owns the host-coupled half of the platform over mTLS gRPC.
#
#   make build     -> ./bin/deplo-agent (static, this platform)
#   make proto     -> regenerate Go + TS stubs from ../proto/agent.proto
#   make test      -> go test ./...
#   make vet       -> go vet ./...

VERSION ?= dev
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

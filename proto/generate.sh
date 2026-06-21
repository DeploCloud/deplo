#!/usr/bin/env bash
# Regenerate the agent gRPC stubs for BOTH sides from proto/agent.proto.
#
# The contract and its two implementations (Go agent, TS control-plane client)
# live in this monorepo (D7) so they move in one commit and cannot drift. Run
# this after editing agent.proto and commit the generated output alongside it.
#
# Requires on PATH: protoc, protoc-gen-go, protoc-gen-go-grpc (Go side, from
# `go install`), and the project's node_modules/.bin (ts-proto, for the TS side).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROTO_DIR="$ROOT/proto"
GO_OUT="$ROOT/agent/gen"
TS_OUT="$ROOT/lib/agent/gen"

# Make the toolchain discoverable whether or not the caller exported it.
export PATH="$PATH:/usr/local/go/bin:${GOPATH:-$HOME/go}/bin:$ROOT/node_modules/.bin"

mkdir -p "$GO_OUT" "$TS_OUT"

echo "[generate] Go stubs -> agent/gen/agentpb"
protoc \
  --proto_path="$PROTO_DIR" \
  --go_out="$GO_OUT" --go_opt=paths=source_relative \
  --go-grpc_out="$GO_OUT" --go-grpc_opt=paths=source_relative \
  agent.proto

echo "[generate] TS stubs -> lib/agent/gen"
# ts-proto with grpc-js client/server stubs. useExactTypes=false keeps the
# generated types permissive enough for our hand-written client wrapper.
protoc \
  --proto_path="$PROTO_DIR" \
  --plugin=protoc-gen-ts_proto="$ROOT/node_modules/.bin/protoc-gen-ts_proto" \
  --ts_proto_out="$TS_OUT" \
  --ts_proto_opt=outputServices=grpc-js,esModuleInterop=true,useOptionals=messages,snakeToCamel=true \
  agent.proto

echo "[generate] done"

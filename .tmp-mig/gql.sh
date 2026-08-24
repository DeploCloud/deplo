#!/bin/bash
# usage: gql.sh <token> <query-file-or-string> [variables-json]
T="$1"; Q="$2"; V="${3:-{\}}"
if [ -f "$Q" ]; then Q=$(cat "$Q"); fi
node -e '
const [q,v]=[process.argv[1],process.argv[2]];
process.stdout.write(JSON.stringify({query:q,variables:JSON.parse(v)}));
' "$Q" "$V" > /tmp/.gqlbody.$$
curl -s -m 300 -X POST http://127.0.0.1:3000/api/graphql -H "Authorization: Bearer $T" -H "Content-Type: application/json" --data-binary @/tmp/.gqlbody.$$
rm -f /tmp/.gqlbody.$$

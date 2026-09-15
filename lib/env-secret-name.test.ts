import { test } from "node:test";
import assert from "node:assert/strict";
import { envNameLooksSensitive } from "./env-secret-name";

const FLAGGED = [
  "PAYLOAD_SECRET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "API_KEY",
  "APIKEY",
  "AUTH",
  "KEY",
  "MY_KEY",
  "DB_PASSWORD",
  "GITHUB_TOKEN",
  "CREDENTIAL",
  "CREDENTIALS",
  "PASSWD",
  "PWORD",
  "SECRET_MESSAGE",
  "SSH_AUTH_SOCK",
  "PROFILE_TOKEN",
  "TOKEN_FILES",
  "TOKEN_PATH",
  "PUB_KEY",
  "token_lower",
];

const CLEAN = [
  "DATABASE_URL",
  "NEXT_PUBLIC_URL",
  "AUTHOR",
  "KEYCLOAK",
  "PASSWORDS",
  "TOKENIZER",
  "SECRETMESSAGE",
  "APP_KEYS",
  "TOKEN2",
  "AWS_REGION",
  "PUBLIC_KEY",
  "NEXT_PUBLIC_API_KEY",
  "TOKEN_FILE",
  "SECRET_FILE_PATH",
  "TOKEN_VERSION",
];

test("flags what docker flags", () => {
  for (const key of FLAGGED)
    assert.equal(envNameLooksSensitive(key), true, key);
});

test("leaves alone what docker leaves alone", () => {
  for (const key of CLEAN) assert.equal(envNameLooksSensitive(key), false, key);
});

import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";

/**
 * A software WebAuthn authenticator, for tests.
 *
 * Everything else about passkeys can be tested by seeding a row; the CEREMONY
 * cannot, and it is where most of the configuration lives. Whether `origin` and
 * `rpID` are right, whether the challenge cookie survives the round trip,
 * whether deplo's `userVerified` guard actually fires, whether the replay
 * counter is written back - none of that is provable without a credential that
 * produces real signatures over real challenges. Driving a browser is not an
 * option in this harness, so the authenticator is the thing that gets simulated.
 *
 * It implements only what `@simplewebauthn/server` needs to accept: ES256 keys,
 * `fmt: "none"` attestation, and the flag bits deplo asks for. That is a
 * deliberate floor - this is not a conformance implementation, and it should
 * never grow into one. If a test needs a shape this does not produce, the honest
 * move is usually that the test is asking for something a real device would not
 * do either.
 *
 * Not named `*.test.ts`, so the `node --test` glob skips it.
 */

/* ------------------------------------------------------------------ */
/* Just enough CBOR                                                     */
/* ------------------------------------------------------------------ */

/**
 * Only the four shapes an attestation object and a COSE key are made of:
 * unsigned ints, negative ints, byte strings, text strings and maps. Written out
 * rather than pulled from a library because the library in question
 * (`@levischuck/tiny-cbor`) is a transitive dependency of the verifier being
 * tested, and a test that shares its dependencies with the thing under test can
 * agree with it about something they are both wrong about.
 */
function head(major: number, n: number): Buffer {
  const tag = major << 5;
  if (n < 24) return Buffer.from([tag | n]);
  if (n < 0x100) return Buffer.from([tag | 24, n]);
  if (n < 0x10000) return Buffer.from([tag | 25, n >> 8, n & 0xff]);
  const b = Buffer.alloc(5);
  b[0] = tag | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

const cborUint = (n: number) => head(0, n);
/** CBOR encodes -1-n, so -7 is major type 1 carrying 6. */
const cborNegative = (n: number) => head(1, -1 - n);
const cborBytes = (b: Buffer) => Buffer.concat([head(2, b.length), b]);
const cborText = (s: string) => {
  const b = Buffer.from(s, "utf8");
  return Buffer.concat([head(3, b.length), b]);
};
const cborMap = (entries: [Buffer, Buffer][]) =>
  Buffer.concat([head(5, entries.length), ...entries.flat()]);

/* ------------------------------------------------------------------ */
/* Flags                                                                */
/* ------------------------------------------------------------------ */

/** Authenticator data flag bits, in the order the spec lays them out. */
export const FLAG = {
  /** User present: somebody touched it. */
  up: 0x01,
  /** User verified: a PIN, a fingerprint or a face - the second factor. */
  uv: 0x04,
  /** Attested credential data follows (registration only). */
  at: 0x40,
} as const;

export interface Authenticator {
  credentialId: Buffer;
  /** Bumped on every assertion, like a real one, so replay checks have something to see. */
  counter: number;
  register(opts: {
    challenge: string;
    origin: string;
    rpId: string;
    flags?: number;
  }): RegistrationResponseLike;
  authenticate(opts: {
    challenge: string;
    origin: string;
    rpId: string;
    flags?: number;
  }): AuthenticationResponseLike;
}

interface RegistrationResponseLike {
  id: string;
  rawId: string;
  type: "public-key";
  clientExtensionResults: Record<string, never>;
  response: {
    clientDataJSON: string;
    attestationObject: string;
    transports: string[];
  };
}

interface AuthenticationResponseLike {
  id: string;
  rawId: string;
  type: "public-key";
  clientExtensionResults: Record<string, never>;
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string;
  };
}

const b64url = (b: Buffer) => b.toString("base64url");

function clientData(
  type: "webauthn.create" | "webauthn.get",
  challenge: string,
  origin: string,
): Buffer {
  // The challenge is echoed back exactly as the server sent it (already
  // base64url), which is what makes it a challenge rather than a nonce we chose.
  return Buffer.from(
    JSON.stringify({ type, challenge, origin, crossOrigin: false }),
    "utf8",
  );
}

function authData(
  rpId: string,
  flags: number,
  counter: number,
  attested?: Buffer,
): Buffer {
  const rpIdHash = createHash("sha256").update(rpId).digest();
  const flagByte = Buffer.from([flags]);
  const count = Buffer.alloc(4);
  count.writeUInt32BE(counter);
  return Buffer.concat(
    attested
      ? [rpIdHash, flagByte, count, attested]
      : [rpIdHash, flagByte, count],
  );
}

/** The COSE_Key form of an ES256 public key: {1:2, 3:-7, -1:1, -2:x, -3:y}. */
function coseKey(publicKey: KeyObject): Buffer {
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");
  return cborMap([
    [cborUint(1), cborUint(2)], // kty: EC2
    [cborUint(3), cborNegative(-7)], // alg: ES256
    [cborNegative(-1), cborUint(1)], // crv: P-256
    [cborNegative(-2), cborBytes(x)],
    [cborNegative(-3), cborBytes(y)],
  ]);
}

/**
 * Mint an authenticator holding one ES256 credential.
 *
 * `aaguid` is all zeroes, which is what privacy-preserving platforms (iCloud
 * Keychain, Android) actually report.
 */
export function makeAuthenticator(): Authenticator {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const credentialId = randomBytes(32);
  const cose = coseKey(publicKey);

  const state = { counter: 0 };

  return {
    credentialId,
    get counter() {
      return state.counter;
    },
    set counter(n: number) {
      state.counter = n;
    },

    register({ challenge, origin, rpId, flags = FLAG.up | FLAG.uv | FLAG.at }) {
      const cdj = clientData("webauthn.create", challenge, origin);
      const credIdLen = Buffer.alloc(2);
      credIdLen.writeUInt16BE(credentialId.length);
      const attested = Buffer.concat([
        Buffer.alloc(16), // aaguid
        credIdLen,
        credentialId,
        cose,
      ]);
      const attestationObject = cborMap([
        [cborText("fmt"), cborText("none")],
        [cborText("attStmt"), cborMap([])],
        [cborText("authData"), cborBytes(authData(rpId, flags, 0, attested))],
      ]);
      return {
        id: b64url(credentialId),
        rawId: b64url(credentialId),
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: b64url(cdj),
          attestationObject: b64url(attestationObject),
          transports: ["internal"],
        },
      };
    },

    authenticate({ challenge, origin, rpId, flags = FLAG.up | FLAG.uv }) {
      state.counter += 1;
      const cdj = clientData("webauthn.get", challenge, origin);
      const ad = authData(rpId, flags, state.counter);
      // The assertion signs the authenticator data concatenated with the HASH of
      // the client data - not the client data itself. Getting this wrong is the
      // classic way a hand-rolled authenticator "works" against a verifier that
      // is also wrong.
      const signed = Buffer.concat([
        ad,
        createHash("sha256").update(cdj).digest(),
      ]);
      const signature = createSign("SHA256").update(signed).sign(privateKey);
      return {
        id: b64url(credentialId),
        rawId: b64url(credentialId),
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: b64url(cdj),
          authenticatorData: b64url(ad),
          signature: b64url(signature),
        },
      };
    },
  };
}

import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  WebAuthnError,
} from "@simplewebauthn/browser";

/**
 * The browser half of a passkey ceremony.
 *
 * Everything else about passkeys is a GraphQL round trip; this is the one part
 * that cannot be, because `navigator.credentials` lives in the page. The two
 * wrappers exist only to hand the server's options straight through - the
 * base64url encoding both directions is what `@simplewebauthn/browser` is for,
 * and it is the same library the verifier on the other end uses, so the wire
 * shapes cannot drift.
 *
 * {@link passkeyError} is the part that earns its keep. What the platform throws
 * is either a bare `NotAllowedError` (which covers "you cancelled", "it timed
 * out" and "your authenticator said no", indistinguishably, by design - the spec
 * collapses them so a page cannot probe for credentials) or a `WebAuthnError`
 * whose message is written for a library author. Neither tells a person what to
 * do next, and one case in particular - the wrong hostname - fails INSIDE the
 * browser before any request is sent, so without a translation it looks like
 * deplo did nothing at all.
 */

/** Whether this browser can do WebAuthn at all. Safe to call during render. */
export function passkeysSupported(): boolean {
  return typeof window !== "undefined" && browserSupportsWebAuthn();
}

/** Run `navigator.credentials.create` with the server's creation options. */
export async function createPasskeyCredential(
  optionsJSON: unknown,
): Promise<unknown> {
  return startRegistration({
    optionsJSON: optionsJSON as Parameters<
      typeof startRegistration
    >[0]["optionsJSON"],
  });
}

/** Run `navigator.credentials.get` with the server's request options. */
export async function getPasskeyAssertion(
  optionsJSON: unknown,
): Promise<unknown> {
  return startAuthentication({
    optionsJSON: optionsJSON as Parameters<
      typeof startAuthentication
    >[0]["optionsJSON"],
  });
}

/**
 * Turn whatever the ceremony threw into one line a person can act on.
 *
 * `panelUrl` is the instance's own address: the domain-mismatch cases are the
 * only ones where the fix is somewhere else entirely, so the message has to name
 * where to go.
 */
export function passkeyError(e: unknown, panelUrl?: string | null): string {
  const wrongPlace = panelUrl
    ? `Passkeys only work on ${panelUrl}. Open the panel there and try again.`
    : "Passkeys only work on the panel's own address, over https.";

  if (e instanceof WebAuthnError) {
    switch (e.code) {
      case "ERROR_CEREMONY_ABORTED":
        return "Cancelled, or it timed out. Try again.";
      case "ERROR_INVALID_DOMAIN":
      case "ERROR_INVALID_RP_ID":
        return wrongPlace;
      case "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED":
        return "That device already has a passkey for this account.";
      case "ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT":
      case "ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT":
        return "That device can't hold a passkey deplo can use. Try your phone, or a security key with a PIN.";
      case "ERROR_AUTHENTICATOR_NO_SUPPORTED_PUBKEYCREDPARAMS_ALG":
      case "ERROR_AUTHENTICATOR_GENERAL_ERROR":
        return "Your device refused to create the passkey. Try a different one.";
    }
  }
  // The bare DOMExceptions, for a browser that threw before the library could
  // narrow it (or a case the library does not cover).
  if (e instanceof Error) {
    if (e.name === "NotAllowedError")
      return "Cancelled, or it timed out. Try again.";
    if (e.name === "InvalidStateError")
      return "That device already has a passkey for this account.";
    if (e.name === "SecurityError") return wrongPlace;
    if (e.name === "NotSupportedError")
      return "This browser or device can't create a passkey.";
    if (e.message) return e.message;
  }
  return "That did not work. Try again.";
}

import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  WebAuthnError,
} from "@simplewebauthn/browser";

export function passkeysSupported(): boolean {
  return typeof window !== "undefined" && browserSupportsWebAuthn();
}

export async function createPasskeyCredential(
  optionsJSON: unknown,
): Promise<unknown> {
  return startRegistration({
    optionsJSON: optionsJSON as Parameters<
      typeof startRegistration
    >[0]["optionsJSON"],
  });
}

export async function getPasskeyAssertion(
  optionsJSON: unknown,
): Promise<unknown> {
  return startAuthentication({
    optionsJSON: optionsJSON as Parameters<
      typeof startAuthentication
    >[0]["optionsJSON"],
  });
}

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
        return "That device can't hold a passkey Deplo can use. Try your phone, or a security key with a PIN.";
      case "ERROR_AUTHENTICATOR_NO_SUPPORTED_PUBKEYCREDPARAMS_ALG":
      case "ERROR_AUTHENTICATOR_GENERAL_ERROR":
        return "Your device refused to create the passkey. Try a different one.";
    }
  }
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

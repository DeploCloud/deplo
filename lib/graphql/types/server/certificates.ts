import { builder } from "../../builder";
import {
  listServerCertificates,
  addServerCertificate,
  removeServerCertificate,
  type ServerCertificate,
} from "@/lib/data/server-certificates";

const ServerCertificateRef = builder
  .objectRef<ServerCertificate>("ServerCertificate")
  .implement({
    description:
      "A TLS certificate the operator installed on a server themselves, described from the certificate itself. It lives in that host's proxy and nowhere else (Deplo stores no copy), and its private key has no read path at all.",
    fields: (t) => ({
      id: t.exposeString("id", {
        description:
          "The certificate's SHA-256 fingerprint, which is also how it is addressed for removal. Nothing is minted: a certificate identifies itself.",
      }),
      subject: t.exposeString("subject", {
        description:
          "Its common name, or its first domain when it carries none.",
      }),
      domains: t.exposeStringList("domains", {
        description:
          "Every hostname this certificate is valid for. Traefik picks a certificate by the domain the browser asked for, so these are the domains it will serve on this host.",
      }),
      issuer: t.exposeString("issuer", { description: "Who signed it." }),
      notBefore: t.exposeString("notBefore", {
        description: "Valid from (ISO-8601).",
      }),
      notAfter: t.exposeString("notAfter", {
        description: "Expires at (ISO-8601).",
      }),
      expired: t.exposeBoolean("expired", {
        description:
          "Whether it is already past its expiry. A certificate can lapse in place long after it was installed, so this is computed, not stored.",
      }),
      expiresInDays: t.exposeInt("expiresInDays", {
        description:
          "Whole days left before it expires, negative once it has. Nothing renews these, so the only warning is this number.",
      }),
    }),
  });

const ServerCertificateInputType = builder.inputType("ServerCertificateInput", {
  description:
    "A certificate and the private key it was issued for, as PEM text.",
  fields: (t) => ({
    certificate: t.string({
      required: true,
      description:
        "The certificate in PEM form. Paste the FULL chain: the certificate followed by any intermediates, which browsers need.",
    }),
    privateKey: t.string({
      required: true,
      description:
        "The matching private key in PEM form, without a passphrase. It is sent to the server and is never readable afterwards.",
    }),
  }),
});

builder.mutationFields((t) => ({
  // MUTATIONS, not queries: they dial the host over the network, and the GraphQL route serves GET.
  serverCertificates: t.field({
    type: [ServerCertificateRef],
    authScopes: { instanceAdmin: true },
    description:
      "List the TLS certificates installed on this server by hand, read live from its proxy. Deplo keeps no copy of them, so this is what the host is actually serving. Errors when Deplo did not install the proxy there.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => listServerCertificates(id),
  }),
  addServerCertificate: t.field({
    type: [ServerCertificateRef],
    authScopes: { instanceAdmin: true },
    description:
      "Install a TLS certificate on this server. The certificate and its key are checked as a pair before the host is touched: a key that does not match, or a certificate that has already expired, is refused. The proxy then serves it for every domain named in it, taking precedence over Let's Encrypt, which stops issuing for domains a certificate already covers. Uploading one for the same domains replaces it. Applying recreates the proxy, so routing on this host is interrupted for a few seconds. Returns the certificates installed afterwards.",
    args: {
      id: t.arg.string({ required: true }),
      input: t.arg({ type: ServerCertificateInputType, required: true }),
    },
    resolve: (_r, { id, input }) =>
      addServerCertificate(id, {
        certPem: input.certificate,
        keyPem: input.privateKey,
      }),
  }),
  removeServerCertificate: t.field({
    type: [ServerCertificateRef],
    authScopes: { instanceAdmin: true },
    description:
      "Remove a certificate from this server by its fingerprint. Its domains fall back to whatever else covers them, usually Let's Encrypt, which issues for them again once the proxy comes back. Recreates the proxy, so routing on this host blips.",
    args: {
      id: t.arg.string({ required: true }),
      certificateId: t.arg.string({ required: true }),
    },
    resolve: (_r, { id, certificateId }) =>
      removeServerCertificate(id, certificateId),
  }),
}));

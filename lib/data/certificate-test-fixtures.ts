// A self-signed pair for acme.example.com and www.acme.example.com, valid until 2051.
export const ACME_CERT = `-----BEGIN CERTIFICATE-----
MIIBwjCCAWigAwIBAgIUPbDAN6OqpzSEYcvFAM01MdpKq9swCgYIKoZIzj0EAwIw
GzEZMBcGA1UEAwwQYWNtZS5leGFtcGxlLmNvbTAgFw0yNjA4MDUxNTQ0MjFaGA8y
MDUxMDMyNzE1NDQyMVowGzEZMBcGA1UEAwwQYWNtZS5leGFtcGxlLmNvbTBZMBMG
ByqGSM49AgEGCCqGSM49AwEHA0IABLd1eAZq0rySOfm0tUIIvWjC5mzuCcInQLRX
UgeJ5h4x+jlVj1kW1BmC/L3Qn8UTNCpeQYYFfFpl7nrlGrmMFuGjgYcwgYQwHQYD
VR0OBBYEFM6nDykL+T4ZNO/+SP25uM7txG2TMB8GA1UdIwQYMBaAFM6nDykL+T4Z
NO/+SP25uM7txG2TMA8GA1UdEwEB/wQFMAMBAf8wMQYDVR0RBCowKIIQYWNtZS5l
eGFtcGxlLmNvbYIUd3d3LmFjbWUuZXhhbXBsZS5jb20wCgYIKoZIzj0EAwIDSAAw
RQIhAPG68SY29VVltPDXJ3/cVTQmhSP1eIP4VkU2CuuCe27SAiAjGRHeKkZla1zU
lDMobM6mUp2E7aZAIhnD86RVLe64fQ==
-----END CERTIFICATE-----
`;

export const ACME_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg7ZiMD+xlQESRAGhR
NWyteGCFri9eZBJnx3HJBlI0ZeGhRANCAAS3dXgGatK8kjn5tLVCCL1owuZs7gnC
J0C0V1IHieYeMfo5VY9ZFtQZgvy90J/FEzQqXkGGBXxaZe565Rq5jBbh
-----END PRIVATE KEY-----
`;

export const TRAEFIK_STACK = `services:
  traefik:
    image: traefik:v3.7
    container_name: deplo-traefik
    command:
      - --entrypoints.web.address=:80
      - --entrypoints.websecure.address=:443
`;

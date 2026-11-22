import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";

import { renderServerView } from "@/components/servers/server-test-helpers";
import { Countdown, LiveSteps, every } from "@/components/shared/live-state";
import { ZoneServerStates } from "@/components/servers/zone-live-states";
import type { ClusterDnsView } from "@/lib/types/cluster-dns";
import { DomainDnsAutoCheck } from "./domain-dns-auto-check";

// Decisions E and G of 22 Nov 2026: the hint is the record the domain needs, and what takes time shows as it moves.

test("a domain the cluster's zone answers is told its CNAME, never an address of one server", () => {
  const html = renderServerView(
    createElement(DomainDnsAutoCheck, {
      domains: [
        {
          id: "dom_1",
          name: "fise.pixelfederico.com",
          status: "pending",
          zone: {
            target: "fise-pixelfederico-com.cluster.pixelfederico.com",
            check: {
              name: "_acme-challenge.fise.pixelfederico.com",
              target:
                "_acme-challenge.fise-pixelfederico-com.cluster.pixelfederico.com",
            },
            kept: false,
          },
        },
      ],
      serverIp: "130.78.60.1",
      serverIpv6: "2a07:7e87:546d:0:be24:11ff:fe40:3a0c",
    }),
  );
  assert.match(html, /CNAME/);
  assert.match(html, /fise-pixelfederico-com\.cluster\.pixelfederico\.com/);
  assert.match(html, /_acme-challenge\.fise\.pixelfederico\.com/);
  assert.doesNotMatch(html, /130\.78\.60\.1|2a07:7e87/);
  assert.doesNotMatch(html, /AAAA/);
});

test("right after a switch from the tunnel the box counts down the caches", () => {
  const html = renderServerView(
    createElement(DomainDnsAutoCheck, {
      domains: [
        {
          id: "dom_1",
          name: "fise.pixelfederico.com",
          status: "valid",
          recordSwitchedAt: new Date(Date.now() - 60_000).toISOString(),
          zone: {
            target: "fise-pixelfederico-com.cluster.pixelfederico.com",
            check: null,
            kept: true,
          },
        },
      ],
    }),
  );
  assert.match(html, /Caches forget fise\.pixelfederico\.com/);
  assert.match(html, /[34]:\d\d left/);
});

test("steps mark the current one, and a countdown shows the time left", () => {
  const steps = renderServerView(
    createElement(LiveSteps, {
      steps: [
        { label: "Record", state: "done" },
        { label: "Certificate, about a minute", state: "current" },
        { label: "Failover ready", state: "todo" },
      ],
    }),
  );
  assert.match(
    steps,
    /aria-current="step"[^>]*>[\s\S]*Certificate, about a minute/,
  );
  const left = renderServerView(
    createElement(Countdown, {
      until: Date.now() + 90_000,
      total: 300_000,
      label: "Caches",
    }),
  );
  assert.match(left, /1:(29|30) left/);
});

test("each name server says how it answers, and an offline one counts down its leaving", () => {
  const base = { serving: true, problem: "", checkedAt: "", nearest: false };
  const dns = {
    dropAfter: 10,
    servers: [
      {
        ...base,
        serverId: "s2",
        serverName: "eu-2",
        state: "answer",
        heard: 2,
        offlineSince: null,
      },
      {
        ...base,
        serverId: "s3",
        serverName: "eu-3",
        state: "answer",
        heard: 2,
        offlineSince: null,
      },
      {
        ...base,
        serverId: "s1",
        serverName: "eu-1",
        state: "fail",
        heard: 1,
        offlineSince: new Date().toISOString(),
      },
    ],
  } as unknown as ClusterDnsView;
  const html = renderServerView(createElement(ZoneServerStates, { dns }));
  assert.match(html, /eu-2<\/span><span[^>]*>Answers, hearing 2 of 3/);
  assert.match(html, /eu-1<\/span><span[^>]*>Offline/);
  assert.match(html, /Leaves the other servers(&#x27;|')? answers/);
});

test("a waiting screen refreshes itself while it is visible, and at once when it comes back", () => {
  let tick: () => void = () => {};
  let back: () => void = () => {};
  let visible = true;
  let calls = 0;
  const stop = every(10_000, () => calls++, {
    setInterval: (fn) => {
      tick = fn;
      return 1;
    },
    clearInterval: () => {
      tick = () => {};
    },
    visible: () => visible,
    onVisible: (fn) => {
      back = fn;
      return () => {
        back = () => {};
      };
    },
  });
  tick();
  visible = false;
  tick();
  visible = true;
  back();
  assert.equal(calls, 2);
  stop();
  tick();
  back();
  assert.equal(calls, 2);
});

import { test } from "node:test";
import assert from "node:assert/strict";

import { cvss3Tenths } from "./cvss";

test("cvss3Tenths: known base scores", () => {
  assert.equal(cvss3Tenths("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"), 98);
  assert.equal(cvss3Tenths("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N"), 75);
  assert.equal(cvss3Tenths("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N"), 53);
  assert.equal(
    cvss3Tenths("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H"),
    100,
  );
  assert.equal(cvss3Tenths("CVSS:3.0/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H"), 78);
  assert.equal(cvss3Tenths("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N"), 0);
});

test("cvss3Tenths: anything else is null", () => {
  assert.equal(cvss3Tenths("CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N"), null);
  assert.equal(
    cvss3Tenths("CVSS:3.1/AV:X/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"),
    null,
  );
  assert.equal(cvss3Tenths(""), null);
});

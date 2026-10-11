process.env.DB_PATH = "data/test-remint-guard.db";

// remintAll() rewrites the entire billing record from whatever logic its
// checkout holds. On 2026-10-11 it ran against production from a clone that
// predated two merged attribution fixes: CI pushes were billed to people again
// (97 spans, 252.8 tokens) and unattributed spans went from 73 to 142, with no
// warning and a success message. These cover the rule that stops that.
import { test } from "node:test";
import assert from "node:assert/strict";

const { stalenessRefusal, ALLOW_STALE } = await import("../src/remint");

const current = {
  backend: "postgres",
  override: false,
  upToDate: true,
  dirtySrc: [] as string[],
  head: "596b40de33a5",
  base: "596b40de33a5",
};

test("a current checkout against postgres proceeds", () => {
  assert.equal(stalenessRefusal(current), null);
});

test("a checkout behind origin/main is refused, and told how to fix it", () => {
  const r = stalenessRefusal({ ...current, upToDate: false, head: "2b24f008f1b5" });
  assert.ok(r, "must refuse");
  assert.match(r!, /behind origin\/main/);
  assert.match(r!, /git pull/);
  assert.match(r!, /2b24f008f1b5/); // names both sides so the gap is visible
  assert.match(r!, /596b40de33a5/);
});

test("uncommitted src/ changes are refused too — stale is not only about commits", () => {
  const r = stalenessRefusal({ ...current, dirtySrc: [" M src/mint.ts"] });
  assert.ok(r);
  assert.match(r!, /uncommitted changes under src\//);
  assert.match(r!, /src\/mint\.ts/);
  // The remedy must match the cause: `git pull` does nothing for a dirty tree,
  // and sending someone back to a command that cannot help wastes the next run.
  assert.match(r!, /commit and push them, or git stash/);
  assert.doesNotMatch(r!, /Fix:\s+git pull/);
});

test("each cause carries the remedy that actually applies to it", () => {
  assert.match(stalenessRefusal({ ...current, upToDate: false })!, /Fix:\s+git pull/);
  assert.match(
    stalenessRefusal({ ...current, unknown: "no network" })!,
    /run from a git clone that can reach origin/,
  );
});

test("facts that could not be gathered are a refusal, not a pass", () => {
  // No git, no network, not a repo: unprovable is not the same as fine, and
  // defaulting to "proceed" would make the guard useless exactly when it matters.
  const r = stalenessRefusal({ ...current, unknown: "not a git repository" });
  assert.ok(r);
  assert.match(r!, /cannot prove this checkout is current/);
  assert.match(r!, /not a git repository/);
});

test("sqlite is exempt, however stale — a scratch database harms nobody", () => {
  assert.equal(
    stalenessRefusal({
      ...current,
      backend: "sqlite",
      upToDate: false,
      dirtySrc: [" M src/mint.ts"],
      unknown: "not a git repository",
    }),
    null,
  );
});

test("the override opens every gate, and is the only thing that does", () => {
  assert.equal(
    stalenessRefusal({
      ...current,
      override: true,
      upToDate: false,
      dirtySrc: [" M src/mint.ts"],
      unknown: "not a git repository",
    }),
    null,
  );
});

test("every refusal names the override, so nobody has to guess the flag", () => {
  for (const f of [
    { ...current, upToDate: false },
    { ...current, dirtySrc: [" M src/mint.ts"] },
    { ...current, unknown: "boom" },
  ]) {
    assert.match(stalenessRefusal(f)!, new RegExp(ALLOW_STALE.replace(/-/g, "\\-")));
  }
});

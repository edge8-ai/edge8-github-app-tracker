process.env.DB_PATH = "data/test-cli-release.db";

// Serving the CLI tarball from the server, so onboarding needs no file transfer.
// The fiddly part is GitHub's asset endpoint: it answers with a 302 to a signed
// object-store URL that REJECTS an Authorization header it did not expect, so
// the redirect has to be followed by hand, unauthenticated.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const H = await import("./helpers");
const { fetchLatestTarball } = await import("../src/cli-release");
const { handleCliDownload } = await import("../src/handlers");

const KEY = "e8k_test0001_" + "a".repeat(48);
const hashOf = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const TGZ = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 1, 2, 3, 4]);

/** A GitHub double: records every request so the auth rules can be asserted. */
function fakeGitHub(o: { assets?: any[]; releaseStatus?: number; assetStatus?: number } = {}) {
  const calls: Array<{ url: string; auth?: string; redirect?: string }> = [];
  const f = async (url: string, init: any = {}) => {
    calls.push({
      url,
      auth: init.headers?.authorization,
      redirect: init.redirect,
    });
    if (url.endsWith("/releases/latest")) {
      const status = o.releaseStatus ?? 200;
      return {
        ok: status < 400,
        status,
        json: async () => ({
          assets: o.assets ?? [
            { name: "notes.txt", url: "https://api.github.com/a/1" },
            { name: "edge8-tracker-0.4.0.tgz", url: "https://api.github.com/a/2" },
          ],
        }),
      };
    }
    if (url.startsWith("https://api.github.com/a/")) {
      const status = o.assetStatus ?? 302;
      return {
        ok: status < 400,
        status,
        headers: { get: (h: string) => (h === "location" ? "https://objects.example/signed" : null) },
        arrayBuffer: async () => TGZ.buffer,
      };
    }
    return { ok: true, status: 200, arrayBuffer: async () => TGZ.buffer };
  };
  return Object.assign(f, { calls });
}

beforeEach(async () => {
  await H.wipe();
  await H.db.run(
    `INSERT INTO engineer_keys (key_id, key_hash, member) VALUES (?,?,?)
     ON CONFLICT (key_id) DO NOTHING`,
    "e8k_test0001",
    hashOf(KEY),
    "dev@local",
  );
});

test("picks the .tgz asset, not whatever happens to be first", async () => {
  const gh = fakeGitHub();
  const r = await fetchLatestTarball("tok", "o/r", gh);
  assert.equal(r.ok, true);
  assert.equal((r as any).tarball.name, "edge8-tracker-0.4.0.tgz");
  assert.deepEqual([...(r as any).tarball.bytes], [...TGZ]);
});

test("the signed redirect is followed WITHOUT the token", async () => {
  const gh = fakeGitHub();
  await fetchLatestTarball("tok", "o/r", gh);

  const asset = gh.calls.find((c) => c.url.startsWith("https://api.github.com/a/2"))!;
  assert.equal(asset.redirect, "manual", "must not let fetch follow it automatically");
  assert.match(asset.auth!, /^Bearer tok$/);

  const signed = gh.calls.find((c) => c.url === "https://objects.example/signed")!;
  assert.ok(signed, "the redirect must actually be followed");
  assert.equal(signed.auth, undefined, "object store rejects an unexpected Authorization");
});

test("no release yet reads as unavailable, not as a broken credential", async () => {
  const r = await fetchLatestTarball("tok", "o/r", fakeGitHub({ releaseStatus: 404 }));
  assert.deepEqual([r.ok, (r as any).status], [false, 503]);
  assert.match((r as any).error, /no published CLI release/);
});

test("a release with no tarball is reported, not served empty", async () => {
  const r = await fetchLatestTarball("tok", "o/r", fakeGitHub({ assets: [{ name: "x.txt", url: "u" }] }));
  assert.deepEqual([r.ok, (r as any).status], [false, 503]);
});

test("a direct 200 asset response is served without chasing a redirect", async () => {
  const gh = fakeGitHub({ assetStatus: 200 });
  const r = await fetchLatestTarball("tok", "o/r", gh);
  assert.equal(r.ok, true);
  assert.ok(!gh.calls.some((c) => c.url === "https://objects.example/signed"));
});

// ── the handler ─────────────────────────────────────────────────────────────

test("a bad key gets nothing", async () => {
  const r = await handleCliDownload("e8k_test0001_" + "b".repeat(48));
  assert.equal(r.status, 401);
  assert.equal(r.bytes, undefined);
});

test("a valid key with no installation gets a reason, not a crash", async () => {
  // No app_installations row covers the release repo.
  const r = await handleCliDownload(KEY, (async () => {
    throw new Error("must not reach GitHub without an installation");
  }) as any);
  assert.equal(r.status, 503);
  assert.match(String((r.json as any).error), /no installation covers/);
});

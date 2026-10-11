process.env.DB_PATH = "data/test-rename.db";

// Attribution must survive a rename — of a repo, its owner, or a person's email.
//
// The live failure these cover: the GitHub org was renamed `talentedgeai` ->
// `edge8-ai` on 2026-09-22. Engineers' remotes kept the old name (GitHub
// redirects silently), webhooks carried the new one, and `attribute()` compared
// the two as strings. 70.8% of every span created afterwards lost its owner.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const H = await import("./helpers");
const { mintForDelivery } = await import("../src/mint");
const { installationForRepoPath } = await import("../src/github");

const OLD = "oldorg/app";
const NEW = "neworg/app";

const alias = (name: string, repoId = 1) =>
  H.db.run(
    `INSERT INTO repo_names (repo_full, repo_id) VALUES (?,?)
     ON CONFLICT (repo_full) DO UPDATE SET repo_id = excluded.repo_id`,
    name,
    repoId,
  );

const emailAlias = (email: string, member: string) =>
  H.db.run(
    `INSERT INTO member_emails (email, member) VALUES (?,?)
     ON CONFLICT (email) DO NOTHING`,
    email,
    member,
  );

beforeEach(async () => {
  await H.wipe();
  await H.seedKey(); // member "dev@local", key e8k_test0001
});

// ── the rename itself ───────────────────────────────────────────────────────

test("a push under the NEW name still finds access events logged under the OLD one", async () => {
  await alias(OLD);
  await alias(NEW);
  // The engineer's remote still says oldorg; the webhook arrives as neworg.
  await H.beacon(H.T("09:00"), { repo: `${OLD}.git` });
  await H.push("d1", H.T("11:24"), { repo_full: NEW });
  await mintForDelivery("d1");

  const [s] = await H.spans();
  assert.equal(s.member, "dev@local"); // before the fix: null + unattributed_push
  assert.equal(s.tokens, 2.4); // and a real span, not the default_1 fallback
  assert.equal(s.rule, "span");
});

test("without an alias the old name no longer matches — the bug, reproduced", async () => {
  // A second key, so attribute()'s "only one active engineer" fallback does not
  // paper over the miss — which is exactly why this went unnoticed in testing.
  await H.seedKey("other@local", "e8k_test0002");
  await H.beacon(H.T("09:00"), { repo: `${OLD}.git` });
  await H.push("d1", H.T("11:24"), { repo_full: NEW });
  await mintForDelivery("d1");

  const [s] = await H.spans();
  assert.equal(s.member, null);
  assert.equal(s.rule, "default_1");
  assert.ok(JSON.parse(s.flags).includes("unattributed_push"));
});

test("a repo with no alias rows still matches by name, so nothing regresses", async () => {
  await H.beacon(H.T("09:00"), { repo: "acme/app.git" });
  await H.push("d1", H.T("11:24"), { repo_full: "acme/app" });
  await mintForDelivery("d1");
  assert.equal((await H.spans())[0].member, "dev@local");
});

test("names that merely look alike are not conflated", async () => {
  await H.seedKey("other@local", "e8k_test0002"); // defeat the single-engineer fallback
  await alias("oldorg/app", 1);
  await alias("someoneelse/app", 99); // same repo NAME, different repo
  await H.beacon(H.T("09:00"), { repo: "someoneelse/app.git" });
  await H.push("d1", H.T("11:24"), { repo_full: NEW, repo_id: 1 });
  await mintForDelivery("d1");
  assert.equal((await H.spans())[0].member, null); // not ours to claim
});

test("ensureProject corrects a stale name instead of keeping it forever", async () => {
  await H.db.run(
    `INSERT INTO projects (repo_id, repo_full, phase, default_branch)
     VALUES (1, ?, 'ship', 'main')`,
    OLD,
  );
  await H.push("d1", H.T("11:24"), { repo_full: NEW });
  await mintForDelivery("d1");

  const p = await H.db.get(`SELECT * FROM projects WHERE repo_id = 1`);
  assert.equal(p.repo_full, NEW); // renamed
  assert.equal(p.phase, "ship"); // but a human's phase is not overwritten
  // ...and the new name is remembered, so the next push needs no backfill.
  const row = await H.db.get(`SELECT repo_id FROM repo_names WHERE repo_full = ?`, NEW);
  assert.equal(Number(row.repo_id), 1);
});

// ── the 404 time bomb ───────────────────────────────────────────────────────

test("a re-clone under the new name resolves, instead of 404ing into silence", async () => {
  await H.db.run(
    `INSERT INTO app_installations (installation_id, account_login, account_type, repo_ids)
     VALUES (555, 'oldorg', 'Organization', ?)`,
    JSON.stringify([1]),
  );
  await H.db.run(
    `INSERT INTO projects (repo_id, repo_full, phase, default_branch)
     VALUES (1, ?, 'build', 'main')`,
    NEW,
  );
  await alias(OLD);
  await alias(NEW);

  // Old remote: matched before via the owner fallback, must keep working.
  assert.ok(await installationForRepoPath(`${OLD}.git`));
  // New remote: no project by that owner, no installation under that login —
  // this is the path that used to 404 and silently stop tracking the engineer.
  assert.ok(await installationForRepoPath(`${NEW}.git`));
  // A genuinely unknown repo is still a 404.
  assert.equal(await installationForRepoPath("nobody/nothing.git"), null);
});

// ── the OWNER rename (migration 0008) ───────────────────────────────────────
//
// repo_names only covers repos that have pushed at least once. For every other
// repo the owner fallback is the safety net, and an owner rename broke it:
// parse.ts overwrites account_login, so after the rename nothing answered to
// the old name while every git remote still used it. Live cost: 19 silent 404s
// on talentedgeai/aio-cert-dashboard, a repo the installation covers.

const installation = (login: string, id = 555, repoIds: number[] = [1]) =>
  H.db.run(
    `INSERT INTO app_installations (installation_id, account_login, account_type, repo_ids)
     VALUES (?,?,?,?)`,
    id,
    login,
    "Organization",
    JSON.stringify(repoIds),
  );

const knownAs = (login: string, id = 555) =>
  H.db.run(
    `INSERT INTO installation_names (account_login, installation_id) VALUES (?,?)
     ON CONFLICT (account_login) DO UPDATE SET installation_id = excluded.installation_id`,
    login,
    id,
  );

test("a repo that never pushed still resolves under the owner's OLD name", async () => {
  await installation("neworg"); // GitHub overwrote the login on rename
  await knownAs("neworg");
  await knownAs("oldorg"); // ...but we remember what it used to be
  // No projects row and no repo_names row: this repo has never pushed, which is
  // exactly the case repo_names cannot help with.
  assert.ok(await installationForRepoPath("oldorg/never-pushed.git"));
  assert.ok(await installationForRepoPath("neworg/never-pushed.git"));
});

test("without the alias the old owner name 404s — the bug, reproduced", async () => {
  await installation("neworg");
  await knownAs("neworg");
  assert.equal(await installationForRepoPath("oldorg/never-pushed.git"), null);
});

test("an alias pointing at a deleted or suspended installation does not resurrect it", async () => {
  await H.db.run(
    `INSERT INTO app_installations (installation_id, account_login, account_type, repo_ids, deleted_at)
     VALUES (?,?,?,?,?)`,
    556,
    "goneorg",
    "Organization",
    JSON.stringify([1]),
    "2026-10-01T00:00:00Z",
  );
  await knownAs("formerly-goneorg", 556);
  assert.equal(await installationForRepoPath("formerly-goneorg/x.git"), null);
});

test("an unknown owner is still a 404, alias table or not", async () => {
  await installation("neworg");
  await knownAs("neworg");
  assert.equal(await installationForRepoPath("stranger/repo.git"), null);
});

// ── the email alias ─────────────────────────────────────────────────────────

test("an author email that is not the key's email still identifies its owner", async () => {
  await H.seedKey("dave@edge8.ai", "e8k_test0002");
  await emailAlias("dave@edge8.co", "dave@edge8.ai");

  // Two engineers touched this repo, so the window is ambiguous and the push's
  // author email is the tie-breaker — the case that could never fire for Dave.
  await H.beacon(H.T("09:00"), { repo: "acme/app.git" });
  await H.beacon(H.T("09:30"), { repo: "acme/app.git", key: "e8k_test0002" });
  await H.push("d1", H.T("11:24"), { author_emails: ["dave@edge8.co"] });
  await mintForDelivery("d1");

  assert.equal((await H.spans())[0].member, "dave@edge8.ai");
});

test("an unaliased email still matches a member directly", async () => {
  await H.seedKey("dave@edge8.ai", "e8k_test0002");
  await H.beacon(H.T("09:00"), { repo: "acme/app.git" });
  await H.beacon(H.T("09:30"), { repo: "acme/app.git", key: "e8k_test0002" });
  await H.push("d1", H.T("11:24"), { author_emails: ["DAVE@edge8.ai"] }); // and case-insensitively
  await mintForDelivery("d1");

  assert.equal((await H.spans())[0].member, "dave@edge8.ai");
});

test("an email belonging to neither candidate leaves the push unattributed", async () => {
  await H.seedKey("dave@edge8.ai", "e8k_test0002");
  await H.beacon(H.T("09:00"), { repo: "acme/app.git" });
  await H.beacon(H.T("09:30"), { repo: "acme/app.git", key: "e8k_test0002" });
  await H.push("d1", H.T("11:24"), { author_emails: ["stranger@example.com"] });
  await mintForDelivery("d1");

  assert.equal((await H.spans())[0].member, null); // guessing would be worse
});

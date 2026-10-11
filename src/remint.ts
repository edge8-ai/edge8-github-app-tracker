import "./env.js";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { db } from "./db.js";
import { mintForDelivery } from "./mint.js";
import { orphanSweep, pairRepoBranch } from "./pairing.js";
import { toMs } from "./time.js";

export const ALLOW_STALE = "--allow-stale-code";

/**
 * Decide whether this checkout may rewrite the production billing record.
 * Returns the refusal to print, or null to proceed. Pure, so the rule can be
 * tested without a git repository behind it.
 *
 * WHY THIS EXISTS. `remintAll()` deletes every work span and rebuilds them from
 * the event log, which means it writes the billing record using whatever logic
 * the checkout it runs from happens to hold — no deploy, no review, no gate.
 *
 * On 2026-10-11 it was run against production from a clone that predated two
 * merged attribution fixes. It rebuilt history under the old rules: CI pushes
 * were billed to people again (97 spans, 252.8 tokens against `github-actions[bot]`)
 * and unattributed spans went from 73 to 142. Nothing warned, and the output
 * looked like a successful run. The damage was undone by pulling and re-running,
 * but only because someone checked the numbers afterwards.
 *
 * So: against Postgres, the code must match what is on origin/main. SQLite is
 * exempt — a local scratch database can be rebuilt from anything, and blocking
 * that would only push people towards the override.
 */
export function stalenessRefusal(f: {
  backend: string;
  override: boolean;
  /** origin/main is an ancestor of HEAD — i.e. this checkout is not behind it. */
  upToDate: boolean;
  /** Tracked files under src/ that differ from HEAD. */
  dirtySrc: string[];
  head: string;
  base: string;
  /** Set when the facts could not be gathered at all (no git, no network). */
  unknown?: string;
}): string | null {
  if (f.backend !== "postgres") return null;
  if (f.override) return null;

  // The remedy differs per cause, so each refusal carries its own — telling
  // someone with uncommitted work to `git pull` just wastes their next attempt.
  const how = (fix: string) =>
    `\n  Fix:      ${fix}` +
    `\n  Override: npm run remint -- ${ALLOW_STALE}    (rebuilds with THIS checkout's logic)`;

  if (f.unknown) {
    return (
      `[remint] refusing: cannot prove this checkout is current (${f.unknown}).` +
      how("run from a git clone that can reach origin")
    );
  }
  if (!f.upToDate) {
    return (
      `[remint] refusing: this checkout is behind origin/main, and remint would rewrite` +
      ` every work span using its logic.\n  HEAD        ${f.head}\n  origin/main ${f.base}` +
      how("git pull    (then re-run)")
    );
  }
  if (f.dirtySrc.length) {
    return (
      `[remint] refusing: uncommitted changes under src/, so the rebuild would use code` +
      ` nobody has reviewed:\n    ${f.dirtySrc.join("\n    ")}` +
      how("commit and push them, or git stash")
    );
  }
  return null;
}

const git = (args: string[]): string =>
  execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/** Gather the facts `stalenessRefusal` judges, then act on its verdict. */
function assertCodeIsCurrent(): void {
  if (db.kind !== "postgres") return;
  const override = process.argv.includes(ALLOW_STALE);

  let facts: Parameters<typeof stalenessRefusal>[0];
  try {
    // Fetch first: comparing against a stale origin/main ref would prove nothing.
    git(["fetch", "origin", "main", "--quiet"]);
    const head = git(["rev-parse", "HEAD"]);
    const base = git(["rev-parse", "origin/main"]);
    let upToDate = true;
    try {
      git(["merge-base", "--is-ancestor", base, "HEAD"]); // non-zero exit -> throws
    } catch {
      upToDate = false;
    }
    facts = {
      backend: db.kind,
      override,
      upToDate,
      dirtySrc: git(["status", "--porcelain", "--", "src"])
        .split("\n")
        .filter(Boolean),
      head: head.slice(0, 12),
      base: base.slice(0, 12),
    };
  } catch (e: any) {
    facts = {
      backend: db.kind,
      override,
      upToDate: false,
      dirtySrc: [],
      head: "?",
      base: "?",
      unknown: String(e?.message ?? e).split("\n")[0],
    };
  }

  const refusal = stalenessRefusal(facts);
  if (refusal) {
    console.error(refusal);
    process.exit(1);
  }
  if (override) {
    console.warn(
      `[remint] ${ALLOW_STALE}: staleness check skipped — the rebuild will use THIS checkout's logic.`,
    );
  }
}

// The mint-engine twin of reparse.ts (brief §8): clear work_spans + capture_flags and
// re-run attribution -> mint -> pairing -> classification over ALL history in event
// order. Every write keys on a natural id, so a second run is a no-op diff.
export async function remintAll(): Promise<{
  pushes: number;
  spans: number;
  flags: number;
}> {
  await db.run(`DELETE FROM work_spans`);
  await db.run(`DELETE FROM capture_flags`);
  await db.run(`UPDATE pull_requests SET author_member = NULL, orphaned = 0`);

  const pushes = await db.all(
    `SELECT delivery_id, repo_id, branch, pushed_at FROM push_events`,
  );
  pushes.sort((a, b) => toMs(a.pushed_at) - toMs(b.pushed_at));

  for (const p of pushes) await mintForDelivery(p.delivery_id);

  const branches = new Map<string, { repo_id: number; branch: string }>();
  for (const p of pushes) {
    if (p.repo_id != null) branches.set(`${p.repo_id}/${p.branch}`, p);
  }
  for (const b of branches.values()) await pairRepoBranch(b.repo_id, b.branch);
  await orphanSweep();

  const spans = (await db.get(`SELECT COUNT(*) AS c FROM work_spans`)).c;
  const flags = (await db.get(`SELECT COUNT(*) AS c FROM capture_flags`)).c;
  return { pushes: pushes.length, spans: Number(spans), flags: Number(flags) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Before the first DELETE, not after: a refusal must leave the table intact.
  assertCodeIsCurrent();
  const r = await remintAll();
  console.log(
    `[remint] ${r.pushes} pushes -> ${r.spans} work_spans, ${r.flags} capture_flags`,
  );
  process.exit(0);
}

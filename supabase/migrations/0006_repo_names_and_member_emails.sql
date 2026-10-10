-- Survive a rename: of an org, and of a person's email.
--
-- WHY. On 2026-09-22 the GitHub org was renamed `talentedgeai` -> `edge8-ai`.
-- Nothing in the tracker noticed, and attribution has been broken ever since:
-- 70.8% of spans created after that date have no member at all (34 of 48), and
-- on edge8-web it is 45 of 47.
--
-- The mechanism. `attribute()` matches an access event to a push BY NAME:
--
--     normRepo(git_access_events.repo_path) === normRepo(push_events.repo_full)
--
-- Engineers' git remotes still say `talentedgeai/...` (GitHub redirects old
-- names silently, so nothing ever forced them to change), while webhooks now
-- say `edge8-ai/...`. The two sides stopped agreeing on the same day the org
-- was renamed, so the 24-hour window is now ALWAYS empty and every push falls
-- through to `unattributed_push` + `default_1`.
--
-- `projects.repo_full` went stale for the same reason: `ensureProject` inserts
-- with `ON CONFLICT (repo_id) DO NOTHING`, so a row written under the old name
-- keeps it forever. 27 rows still said `talentedgeai/...`; only repos created
-- after the rename carried the new name.
--
-- There is a live hazard in that too. `installationForRepoPath` resolves a repo
-- by name, then falls back to matching the OWNER against
-- `app_installations.account_login`, which is also still `talentedgeai`. Old
-- remotes therefore still mint. The moment anyone re-clones and their remote
-- says `edge8-ai/...`, neither lookup matches, the server answers 404, and the
-- helper — which treats 404 as "not a tracked repo" — silently falls through to
-- their personal credentials. They stop being tracked with a green
-- `tracker status`. No such event has been recorded yet; this closes it first.
--
-- THE FIX is to stop treating a name as an identity.
--
--   repo_names     every name a repo has ever been known by -> its stable
--                  repo_id. GitHub repo ids survive renames and transfers, so
--                  both sides of the match can be resolved to one key.
--   member_emails  every email a person commits under -> their member identity.
--
-- The second table exists because the same class of bug hides in the
-- disambiguation fallback: when the window names more than one member,
-- `disambiguate` compares the push's author emails against member emails. Dave
-- commits as `dave@edge8.co` while his key says `dave@edge8.ai` — a different
-- TLD — so that fallback could never fire for him either.

create table if not exists tracker.repo_names (
  repo_full   text primary key,
  repo_id     bigint not null,
  recorded_at text not null default to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
);

create index if not exists repo_names_repo_id_idx on tracker.repo_names (repo_id);

comment on table tracker.repo_names is
  'Every name a repo has been known by -> its stable GitHub repo_id. Written on every push, so a rename self-heals on the next one. Names are stored lowercased.';

-- Backfill from history. push_events already holds both the pre- and
-- post-rename names against the same repo_id, so the full alias map is simply
-- sitting there — 1754 pushes under the old org name, 2521 under the new.
insert into tracker.repo_names (repo_full, repo_id)
select distinct lower(repo_full), repo_id
  from tracker.push_events
 where repo_full is not null and repo_id is not null
on conflict (repo_full) do nothing;

insert into tracker.repo_names (repo_full, repo_id)
select distinct lower(repo_full), repo_id
  from tracker.projects
 where repo_full is not null and repo_id is not null
on conflict (repo_full) do nothing;

-- Bring projects up to each repo's CURRENT name (its most recent push), rather
-- than waiting for the next push to heal each row one at a time.
update tracker.projects p
   set repo_full = latest.repo_full
  from (select distinct on (repo_id) repo_id, repo_full
          from tracker.push_events
         where repo_full is not null
         order by repo_id, pushed_at desc) latest
 where latest.repo_id = p.repo_id
   and p.repo_full is distinct from latest.repo_full;

create table if not exists tracker.member_emails (
  email  text primary key,
  member text not null,
  note   text
);

create index if not exists member_emails_member_idx on tracker.member_emails (member);

comment on table tracker.member_emails is
  'Commit author email -> member identity, for attribution disambiguation. Every engineer_keys.member maps to itself; extra rows are aliases. Emails are stored lowercased.';

-- Every member is an alias of themselves, so the lookup needs no special case.
insert into tracker.member_emails (email, member, note)
select distinct lower(member), lower(member), 'identity'
  from tracker.engineer_keys
 where member is not null and member <> ''
on conflict (email) do nothing;

-- Aliases below are evidence-based, not guesses: each email was checked against
-- the GitHub login that pushed it. Add new ones the same way — confirm the
-- sender_login first, never infer a person from an email's shape.
--
--   dave@edge8.co                    318 pushes as dhajdu
--   dhajdu@users.noreply.github.com  629 pushes as dhajdu
--   dhajdu@gmail.com                   8 pushes as dhajdu (100%)
--   anhkhoadoanngoc19@gmail.com      807 pushes as dnakhoa, whose work email
--                                    khoa.doan@edge8.ai is already a key member
insert into tracker.member_emails (email, member, note) values
  ('dave@edge8.co',                   'dave@edge8.ai',      'dhajdu: 318 pushes'),
  ('dhajdu@users.noreply.github.com', 'dave@edge8.ai',      'dhajdu: 629 pushes'),
  ('dhajdu@gmail.com',                'dave@edge8.ai',      'dhajdu: 8 pushes'),
  ('anhkhoadoanngoc19@gmail.com',     'khoa.doan@edge8.ai', 'dnakhoa: 807 pushes')
on conflict (email) do nothing;

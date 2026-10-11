-- The owner rename, which 0006 only half fixed.
--
-- WHY. `installationForRepoPath` resolves a repo to an installation by id when
-- it can, and otherwise falls back to matching the repo's OWNER against
-- `app_installations.account_login`. 0006 fixed the first half: `repo_names`
-- maps every name a repo has been known by onto its stable repo_id, so an old
-- remote still resolves — but only for a repo that has pushed at least once,
-- because that is how rows get into `repo_names`.
--
-- For every other repo the owner fallback is the safety net, and the rename
-- broke it. `parse.ts` upserts installations with
-- `account_login = excluded.account_login`, so when GitHub sent an installation
-- webhook after the org was renamed, installation 145237719 stopped being
-- `talentedgeai` and became `edge8-ai`. No row answers to the old name now.
--
-- The effect is live, and it is the opposite shape to the one predicted when
-- 0006 shipped: the failures appear under the OLD owner name, not the new one,
-- because engineers' remotes still say `talentedgeai` while the installation
-- row says `edge8-ai`. `talentedgeai/aio-cert-dashboard` — a repo covered by
-- the installation, which simply has not pushed since capture began — returned
-- `no_installation` 19 times to Dave, through 2026-10-08. The helper reads 404
-- as "not a tracked repo" and silently falls through to personal credentials,
-- so every one of those operations went untracked with nothing to show for it.
--
-- THE FIX, same shape as repo_names: remember every login an installation has
-- answered to, and let the fallback resolve through that.

create table if not exists tracker.installation_names (
  account_login   text primary key,
  installation_id bigint not null,
  recorded_at     text not null default to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
);

create index if not exists installation_names_installation_idx
  on tracker.installation_names (installation_id);

comment on table tracker.installation_names is
  'Every account login an installation has been known by -> its installation_id. Written on every installation webhook, so an owner rename self-heals. Logins are stored lowercased.';

-- Current logins first, so a live name always wins the primary key.
insert into tracker.installation_names (account_login, installation_id)
select lower(account_login), installation_id
  from tracker.app_installations
 where account_login is not null
on conflict (account_login) do nothing;

-- Then historical owners, derived rather than hard-coded: any owner name that
-- appears in repo_names for a repo an installation covers has, by definition,
-- been that installation's account at some point. This picks up `talentedgeai`
-- without naming it, and will pick up the next rename the same way.
insert into tracker.installation_names (account_login, installation_id)
select distinct split_part(rn.repo_full, '/', 1), ai.installation_id
  from tracker.repo_names rn
  join tracker.app_installations ai
    on (ai.repo_ids::jsonb) @> to_jsonb(rn.repo_id)
 where ai.deleted_at is null
   and ai.suspended_at is null
on conflict (account_login) do nothing;

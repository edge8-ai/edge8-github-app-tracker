-- One more commit-author alias: Quan.
--
-- WHY. After 0006 and a remint, 14 of 96 spans still had no owner. Five of them
-- were pushes authored as `qdchau@gmail.com` on edge8-ai/edge8-web — Quan, whose
-- key says `quan@edge8.ai`. 0006 seeded only the addresses that had been checked
-- against a GitHub login at the time, and this one had not been; the gap showed
-- up the moment real data ran through the new disambiguation path.
--
-- Checked the same way as the others before adding it: `qdchau@gmail.com`
-- appears on 13 pushes sent by `quanchau8`, and `quan@edge8.ai` is already an
-- engineer_keys member. Never infer a person from an email's shape — confirm the
-- sender_login first.
--
-- This does not fix the other nine. Seven are pushes on edge8-ai/aiolabz-fe
-- authored by Dave, who IS aliased: their 24-hour window holds no access event
-- at all, and disambiguation only runs when there are candidates to choose
-- between. Two carry no author email, so there is nothing to match on. Neither
-- is an alias problem.

insert into tracker.member_emails (email, member, note) values
  ('qdchau@gmail.com', 'quan@edge8.ai', 'quanchau8: 13 pushes')
on conflict (email) do nothing;

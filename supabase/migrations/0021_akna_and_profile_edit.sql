-- ============================================================================
-- Gahoi Portal — Migration 0021: Akna matching + Profile edit support
--
--  1. canonical_akna(text)  : Hindi / English / variant kuch bhi type ho, akna_list ka asli
--                             (Hindi) naam lautata hai; match na ho to NULL.
--  2. persons.akna trigger  : save hote hi akna canonical Hindi mein badal jata hai (signup, profile
--                             edit, admin edit — sab raaste). Na-pehchana akna `pending_aknas` mein
--                             ginti ke saath darj hota hai (legacy "PendingAknas" sheet ki jagah).
--  3. Mobile validation     : profile edit mein mobile badle to format/fake-pattern ki jaanch.
--  4. Identity audit        : name/mobile/email/akna/city/native/father badle to audit_log mein
--                             (mobile/email masked) — legacy EDIT_PROFILE jaisa.
--  5. Email sync            : Supabase Auth mein email confirm hote hi persons.email apne-aap badal jata hai.
-- ============================================================================

-- 1) canonical_akna ---------------------------------------------------------
create or replace function canonical_akna(p_text text)
returns text language sql stable security definer set search_path = public as $$
  select a.hindi
  from akna_list a
  where a.active and nullif(btrim(p_text), '') is not null
    and (   lower(btrim(a.hindi)) = lower(btrim(p_text))
         or lower(btrim(coalesce(a.english, ''))) = lower(btrim(p_text))
         or lower(btrim(p_text)) = any (regexp_split_to_array(lower(coalesce(a.variants, '')), '[\s,;|]+')))
  order by (lower(btrim(a.hindi)) = lower(btrim(p_text))) desc,
           (lower(btrim(coalesce(a.english, ''))) = lower(btrim(p_text))) desc,
           a.added_at, a.hindi
  limit 1;
$$;
grant execute on function canonical_akna(text) to anon, authenticated;

-- 2) pending_aknas + normalize trigger --------------------------------------
create table if not exists pending_aknas (
  id            uuid primary key default gen_random_uuid(),
  akna          text not null,
  first_gahoi_id text,
  seen_count    int not null default 1,
  status        text not null default 'Pending' check (status in ('Pending','Added','Mapped','Rejected')),
  resolved_to   text,
  admin_note    text,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  resolved_by   text,
  resolved_at   timestamptz
);
create unique index if not exists uq_pending_akna_lower on pending_aknas (lower(btrim(akna)));
alter table pending_aknas enable row level security;
drop policy if exists pending_aknas_read on pending_aknas;
create policy pending_aknas_read on pending_aknas for select to authenticated using (is_approver_or_admin());
drop policy if exists pending_aknas_write on pending_aknas;
create policy pending_aknas_write on pending_aknas for update to authenticated using (is_approver_or_admin()) with check (is_approver_or_admin());

create or replace function persons_normalize_akna() returns trigger
language plpgsql security definer set search_path = public as $$
declare v text;
begin
  if new.akna is null or btrim(new.akna) = '' then return new; end if;
  new.akna := btrim(new.akna);
  v := canonical_akna(new.akna);
  if v is not null then
    new.akna := v;
  elsif tg_op = 'INSERT' or new.akna is distinct from old.akna then
    insert into pending_aknas as pa (akna, first_gahoi_id) values (new.akna, new.gahoi_id)
    on conflict (lower(btrim(akna))) do update
      set seen_count = pa.seen_count + 1, last_seen_at = now(),
          status = case when pa.status in ('Rejected') then 'Pending' else pa.status end;
  end if;
  return new;
end;
$$;
drop trigger if exists b_normalize_akna on persons;
create trigger b_normalize_akna before insert or update of akna on persons
  for each row execute function persons_normalize_akna();

-- 3) Mobile validation (sirf user-session se badle to; migration/admin function par nahi) ----------
create or replace function persons_validate_mobile() returns trigger
language plpgsql as $$
begin
  if auth.uid() is null then return new; end if;
  if tg_op = 'UPDATE' and new.mobile is not distinct from old.mobile then return new; end if;
  if new.mobile is null or new.mobile !~ '^[6-9][0-9]{9}$' then
    raise exception 'Mobile 10 अंकों का होना चाहिए और 6, 7, 8 या 9 से शुरू (जैसे 98XXXXXXXX)।';
  end if;
  if new.mobile ~ '^([0-9])\1{9}$' or new.mobile in ('0123456789','1234567890','9876543210') then
    raise exception 'यह मोबाइल नंबर सही नहीं लगता — असली नंबर डालें।';
  end if;
  return new;
end;
$$;
drop trigger if exists c_validate_mobile on persons;
create trigger c_validate_mobile before insert or update of mobile on persons
  for each row execute function persons_validate_mobile();

-- 4) Identity-change audit ----------------------------------------------------
create or replace function persons_audit_identity() returns trigger
language plpgsql security definer set search_path = public as $$
declare d text := '';
  function_actor text := current_gahoi_id();
  mask_m text; mask_e text;
begin
  if auth.uid() is null then return new; end if;
  if new.name   is distinct from old.name   then d := d || 'Name: ' || coalesce(old.name,'—') || ' → ' || coalesce(new.name,'—') || ' | '; end if;
  if new.father is distinct from old.father then d := d || 'Father: ' || coalesce(old.father,'—') || ' → ' || coalesce(new.father,'—') || ' | '; end if;
  if new.akna   is distinct from old.akna   then d := d || 'Akna: ' || coalesce(old.akna,'—') || ' → ' || coalesce(new.akna,'—') || ' | '; end if;
  if new.city   is distinct from old.city   then d := d || 'City: ' || coalesce(old.city,'—') || ' → ' || coalesce(new.city,'—') || ' | '; end if;
  if new.native is distinct from old.native then d := d || 'Native: ' || coalesce(old.native,'—') || ' → ' || coalesce(new.native,'—') || ' | '; end if;
  if new.mobile is distinct from old.mobile then
    d := d || 'Mobile: ' || coalesce(repeat('x', 6) || right(old.mobile, 4), '—') || ' → ' || coalesce(repeat('x', 6) || right(new.mobile, 4), '—') || ' | ';
  end if;
  if new.email is distinct from old.email then
    d := d || 'Email: ' || coalesce(left(old.email, 2) || '***@' || split_part(old.email, '@', 2), '—') || ' → ' || coalesce(left(new.email, 2) || '***@' || split_part(new.email, '@', 2), '—') || ' | ';
  end if;
  if d <> '' then
    insert into audit_log (action, actor_gahoi_id, actor_name, actor_email, target, detail, result)
    values ('EDIT_PROFILE', function_actor, new.name, null, new.gahoi_id, left(d, 900), 'SUCCESS');
  end if;
  return new;
end;
$$;
drop trigger if exists z_audit_identity on persons;
create trigger z_audit_identity after update on persons
  for each row execute function persons_audit_identity();

-- 5) Auth email -> persons.email sync -------------------------------------------
create or replace function sync_person_email() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.email is not null and new.email is distinct from old.email then
    begin
      update persons set email = lower(new.email) where auth_uid = new.id and email is distinct from lower(new.email);
    exception when unique_violation then
      null;   -- koi aur person usi email par hai — auth update ko fail na karo
    end;
  end if;
  return new;
end;
$$;
drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed after update of email on auth.users
  for each row execute function sync_person_email();

-- 6) Admin: na-pehchane akna ka faisla (legacy PendingAknas sheet ka review) ---------------
--   p_action = 'add'    -> naya akna akna_list mein jodo (p_hindi, p_english, p_variants) + sab members ka akna usi mein badlo
--   p_action = 'map'    -> maujooda akna (p_hindi) se jodo: typed spelling uska 'variant' ban jata hai (agli baar apne-aap match)
--   p_action = 'reject' -> sirf band karo (members ka text jaisa hai waisa rahega)
create or replace function resolve_pending_akna(p_id uuid, p_action text, p_hindi text default null, p_english text default null, p_variants text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare pa pending_aknas%rowtype; target text; moved int := 0; me text := current_gahoi_id();
begin
  if not coalesce(is_approver_or_admin(), false) then raise exception 'Not allowed'; end if;
  select * into pa from pending_aknas where id = p_id for update;
  if not found then raise exception 'Pending akna nahi mila'; end if;

  if p_action = 'add' then
    target := nullif(btrim(p_hindi), '');
    if target is null then raise exception 'Hindi naam zaroori hai'; end if;
    if exists (select 1 from akna_list where lower(btrim(hindi)) = lower(target)) then
      raise exception 'Ye akna list mein pehle se hai — "map" use karein';
    end if;
    insert into akna_list (hindi, english, variants, active, added_by)
    values (target, nullif(btrim(p_english), ''), nullif(btrim(coalesce(p_variants, '') || ' ' || coalesce(p_english, '') || ' ' || pa.akna), ''), true, me);
  elsif p_action = 'map' then
    select hindi into target from akna_list where active and lower(btrim(hindi)) = lower(btrim(coalesce(p_hindi, ''))) limit 1;
    if target is null then raise exception 'Chuna hua akna list mein nahi hai'; end if;
    update akna_list set variants = btrim(coalesce(variants, '') || ' ' || lower(btrim(pa.akna))) where hindi = target
      and not (lower(btrim(pa.akna)) = any (regexp_split_to_array(lower(coalesce(variants, '')), '[\s,;|]+')));
  elsif p_action = 'reject' then
    update pending_aknas set status = 'Rejected', resolved_by = me, resolved_at = now() where id = p_id;
    return jsonb_build_object('ok', true, 'moved', 0);
  else
    raise exception 'Unknown action';
  end if;

  update persons set akna = target where lower(btrim(akna)) = lower(btrim(pa.akna)) and akna is distinct from target;
  get diagnostics moved = row_count;
  update pending_aknas set status = case when p_action = 'add' then 'Added' else 'Mapped' end, resolved_to = target, resolved_by = me, resolved_at = now() where id = p_id;
  return jsonb_build_object('ok', true, 'moved', moved, 'akna', target);
end;
$$;
revoke all on function resolve_pending_akna(uuid,text,text,text,text) from public, anon;
grant execute on function resolve_pending_akna(uuid,text,text,text,text) to authenticated;

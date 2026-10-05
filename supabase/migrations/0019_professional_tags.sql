-- ============================================================================
-- Gahoi Portal — Migration 0019: Samaj ke logon ke Professional / Public-life tags
-- (Doctor, Engineer, Advocate, CA, Politician, ... — registered members AUR census entries)
--
-- Design:
--  * profession_categories : admin-editable taxonomy (seed neeche). `sensitive` = true wali
--    category (Politician) ka tag tabhi doosron ko dikhta hai jab us person ne KHUD confirm kiya ho
--    (DPDP: political affiliation sensitive; census entry confirm kar hi nahi sakta => admin-only rehta hai).
--  * person_professions    : ek person ke kai tags. Direct SELECT sirf owner/admin ko; baaki sab
--    search_professionals() RPC se (sirf safe columns — mobile/email/address kabhi nahi).
--  * person_profession_private : registration no. / proof — sirf owner + Admin/Approver.
--  * Verification: unverified -> pending -> verified/rejected; sirf Admin/Approver badal sakte hain.
-- ============================================================================

create table if not exists profession_categories (
  slug        text primary key,
  label_hi    text not null,
  label_en    text not null,
  group_key   text not null default 'other',
  icon        text default '🏷',
  sensitive   boolean not null default false,
  sort_order  int not null default 100,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

insert into profession_categories (slug, label_hi, label_en, group_key, icon, sensitive, sort_order) values
  ('doctor',       'डॉक्टर (MBBS/MD/MS)',          'Doctor',                    'medical',  '🩺', false, 10),
  ('dentist',      'दंत चिकित्सक',                  'Dentist',                   'medical',  '🦷', false, 11),
  ('ayush',        'वैद्य / आयुष (आयुर्वेद/होम्योपैथी)', 'AYUSH Practitioner',          'medical',  '🌿', false, 12),
  ('pharmacist',   'फार्मासिस्ट',                    'Pharmacist',                'medical',  '💊', false, 13),
  ('engineer',     'इंजीनियर',                      'Engineer',                  'engineering','🛠', false, 20),
  ('architect',    'आर्किटेक्ट',                     'Architect',                 'engineering','📐', false, 21),
  ('advocate',     'अधिवक्ता (वकील)',                'Advocate',                  'legal',    '⚖️', false, 30),
  ('judiciary',    'न्यायिक सेवा',                   'Judiciary',                 'legal',    '🏛', false, 31),
  ('ca',           'चार्टर्ड अकाउंटेंट (CA)',         'Chartered Accountant',      'finance',  '📊', false, 40),
  ('cs_cma',       'कंपनी सेक्रेटरी / CMA',          'Company Secretary / CMA',   'finance',  '📑', false, 41),
  ('banker',       'बैंकिंग / बीमा',                 'Banking / Insurance',       'finance',  '🏦', false, 42),
  ('teacher',      'शिक्षक / प्रोफ़ेसर',              'Teacher / Professor',       'education','🎓', false, 50),
  ('researcher',   'वैज्ञानिक / शोधकर्ता',            'Scientist / Researcher',    'education','🔬', false, 51),
  ('govt_officer', 'सरकारी अधिकारी (IAS/IPS/PCS आदि)', 'Government Officer',        'government','🏢', false, 60),
  ('police_defence','पुलिस / सेना / अर्धसैनिक',        'Police / Defence',          'government','🎖', false, 61),
  ('politician',   'राजनीति / जनप्रतिनिधि',          'Politician / Public Representative','public','🗳', true, 70),
  ('social_worker','समाजसेवी',                       'Social Worker',             'public',   '🤝', false, 71),
  ('businessman',  'व्यवसायी / उद्योगपति',            'Businessman / Industrialist','business','💼', false, 80),
  ('it_professional','IT / सॉफ़्टवेयर',               'IT / Software',             'technology','💻', false, 90),
  ('media_arts',   'पत्रकार / कलाकार / खिलाड़ी',       'Media / Arts / Sports',     'media',    '🎭', false, 100),
  ('farmer',       'किसान / कृषि',                   'Farmer / Agriculture',      'agriculture','🌾', false, 110),
  ('religious',    'पंडित / ज्योतिष / धर्माचार्य',     'Priest / Astrologer / Religious','religious','🕉', false, 120),
  ('other',        'अन्य',                          'Other',                     'other',    '🏷', false, 999)
on conflict (slug) do nothing;

create table if not exists person_professions (
  id                  uuid primary key default gen_random_uuid(),
  person_gahoi_id     text not null references persons(gahoi_id) on delete cascade,
  category_slug       text not null references profession_categories(slug),
  title               text,            -- Cardiologist / Civil Engineer / Sarpanch / MLA ...
  organization        text,
  specialization      text,
  qualification       text,
  city                text,
  details             jsonb not null default '{}'::jsonb,   -- politician: {party, office, level, area, since}
  visibility          text not null default 'members' check (visibility in ('members','public','hidden')),
  source              text not null default 'self' check (source in ('self','coordinator','admin','auto-migration')),
  member_confirmed    boolean not null default false,
  verification_status text not null default 'unverified' check (verification_status in ('unverified','pending','verified','rejected')),
  verified_by         text,
  verified_at         timestamptz,
  verification_note   text,
  created_by          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz
);
create unique index if not exists uq_person_prof_active
  on person_professions (person_gahoi_id, category_slug, coalesce(lower(title), ''))
  where deleted_at is null;
create index if not exists idx_pp_category on person_professions (category_slug) where deleted_at is null;
create index if not exists idx_pp_person   on person_professions (person_gahoi_id) where deleted_at is null;
create index if not exists idx_pp_status   on person_professions (verification_status) where deleted_at is null;

create table if not exists person_profession_private (
  profession_id uuid primary key references person_professions(id) on delete cascade,
  reg_no        text,       -- Medical Council / Bar Council / ICAI membership no.
  proof_url     text
);

-- ───────── Triggers ─────────
create or replace function pp_before_write() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_me   text := current_gahoi_id();
  v_priv boolean := coalesce(is_approver_or_admin(), false);
begin
  if tg_op = 'INSERT' then
    if auth.uid() is null then            -- SQL editor / service key / migration script: values jaisi di gayi waisi
      return new;
    end if;
    if new.person_gahoi_id = v_me then
      new.source := 'self'; new.member_confirmed := true;
    else
      if not v_priv then raise exception 'Not allowed to tag this person'; end if;
      new.source := case when coalesce(new.source,'') = 'coordinator' then 'coordinator' else 'admin' end;
      new.member_confirmed := false;
    end if;
    new.created_by := v_me;
    if not v_priv then new.verification_status := 'unverified'; new.verified_by := null; new.verified_at := null; end if;
    return new;
  end if;

  -- UPDATE
  new.updated_at := now();
  if auth.uid() is null then return new; end if;
  if not v_priv then
    new.person_gahoi_id := old.person_gahoi_id;
    new.source := old.source; new.created_by := old.created_by;
    new.verified_by := old.verified_by; new.verified_at := old.verified_at; new.verification_note := old.verification_note;
    -- owner sirf ye transitions kar sakta hai: unverified/rejected -> pending (verification maange); baaki status same
    if new.verification_status is distinct from old.verification_status
       and not (new.verification_status = 'pending' and old.verification_status in ('unverified','rejected')) then
      new.verification_status := old.verification_status;
    end if;
    -- owner sirf apna confirm kar sakta hai
    if old.person_gahoi_id <> v_me then raise exception 'Not your tag'; end if;
    -- verified tag ka asli content badle to dobara verify karwana padega
    if old.verification_status = 'verified'
       and (new.category_slug is distinct from old.category_slug or new.title is distinct from old.title or new.organization is distinct from old.organization) then
      new.verification_status := 'unverified'; new.verified_by := null; new.verified_at := null;
    end if;
  else
    if new.verification_status = 'verified' and old.verification_status <> 'verified' then
      new.verified_by := v_me; new.verified_at := now();
    elsif new.verification_status <> 'verified' and old.verification_status = 'verified' then
      new.verified_by := null; new.verified_at := null;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_pp_before_write on person_professions;
create trigger trg_pp_before_write before insert or update on person_professions
  for each row execute function pp_before_write();

-- ───────── RLS ─────────
alter table profession_categories      enable row level security;
alter table person_professions         enable row level security;
alter table person_profession_private  enable row level security;

drop policy if exists pc_read   on profession_categories;
create policy pc_read  on profession_categories for select to anon, authenticated using (true);
drop policy if exists pc_write  on profession_categories;
create policy pc_write on profession_categories for all to authenticated using (is_admin()) with check (is_admin());

drop policy if exists pp_select on person_professions;
create policy pp_select on person_professions for select to authenticated
  using (person_gahoi_id = current_gahoi_id() or is_approver_or_admin());
drop policy if exists pp_insert on person_professions;
create policy pp_insert on person_professions for insert to authenticated
  with check (person_gahoi_id = current_gahoi_id() or is_approver_or_admin());
drop policy if exists pp_update on person_professions;
create policy pp_update on person_professions for update to authenticated
  using (person_gahoi_id = current_gahoi_id() or is_approver_or_admin())
  with check (person_gahoi_id = current_gahoi_id() or is_approver_or_admin());
drop policy if exists pp_delete on person_professions;
create policy pp_delete on person_professions for delete to authenticated using (is_admin());

drop policy if exists ppp_all on person_profession_private;
create policy ppp_all on person_profession_private for all to authenticated
  using (is_approver_or_admin() or exists (select 1 from person_professions p where p.id = profession_id and p.person_gahoi_id = current_gahoi_id()))
  with check (is_approver_or_admin() or exists (select 1 from person_professions p where p.id = profession_id and p.person_gahoi_id = current_gahoi_id()));

-- ───────── Directory RPCs (sirf safe columns; mobile/email/address kabhi nahi) ─────────
create or replace function search_professionals(
  p_category text default null, p_q text default null, p_city text default null,
  p_verified_only boolean default false, p_limit int default 20, p_offset int default 0)
returns table (gahoi_id text, name text, photo text, city text, native text, akna text,
               is_registered boolean, tags jsonb, total_count bigint)
language plpgsql stable security definer set search_path = public as $$
declare v_q text := nullif(trim(coalesce(p_q,'')), '');
        v_city text := nullif(trim(coalesce(p_city,'')), '');
begin
  if not (coalesce(is_approved_member(), false) or coalesce(is_approver_or_admin(), false)) then
    raise exception 'Not allowed';
  end if;
  return query
  with vis as (            -- doosron ko dikhne layak tags
    select pp.*, c.label_hi, c.label_en, c.icon
    from person_professions pp join profession_categories c on c.slug = pp.category_slug
    where pp.deleted_at is null and c.active and pp.visibility <> 'hidden'
      and (not c.sensitive or pp.member_confirmed)
  ),
  matched as (
    select distinct p.gahoi_id
    from persons p join vis v on v.person_gahoi_id = p.gahoi_id
    where p.status = 'Approved'
      and (p_category is null or v.category_slug = p_category)
      and (not p_verified_only or v.verification_status = 'verified')
      and (v_city is null or lower(coalesce(p.city,'') || ' ' || coalesce(v.city,'')) like '%' || lower(v_city) || '%')
      and (v_q is null or lower(concat_ws(' ', p.name, p.native, p.akna, v.title, v.organization, v.specialization, v.qualification, v.label_hi, v.label_en)) like '%' || lower(v_q) || '%')
  ),
  total as (select count(*) as n from matched)
  select p.gahoi_id, p.name,
         case when p.auth_uid is not null then p.photo else null end,
         p.city, p.native, p.akna, (p.auth_uid is not null),
         (select coalesce(jsonb_agg(jsonb_build_object(
                   'id', v.id, 'category', v.category_slug, 'label_hi', v.label_hi, 'icon', v.icon,
                   'title', v.title, 'organization', v.organization, 'specialization', v.specialization,
                   'qualification', v.qualification, 'city', v.city, 'details', v.details,
                   'verified', v.verification_status = 'verified') order by v.category_slug, v.title), '[]'::jsonb)
            from vis v where v.person_gahoi_id = p.gahoi_id),
         (select n from total)
  from persons p join matched m on m.gahoi_id = p.gahoi_id
  order by p.name
  limit least(greatest(p_limit,1),100) offset greatest(p_offset,0);
end;
$$;

create or replace function profession_category_counts()
returns table (slug text, label_hi text, label_en text, icon text, group_key text, sort_order int, people bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  if not (coalesce(is_approved_member(), false) or coalesce(is_approver_or_admin(), false)) then raise exception 'Not allowed'; end if;
  return query
  select c.slug, c.label_hi, c.label_en, c.icon, c.group_key, c.sort_order,
         (select count(distinct pp.person_gahoi_id) from person_professions pp join persons p on p.gahoi_id = pp.person_gahoi_id
           where pp.category_slug = c.slug and pp.deleted_at is null and pp.visibility <> 'hidden'
             and (not c.sensitive or pp.member_confirmed) and p.status = 'Approved')
  from profession_categories c where c.active order by c.sort_order, c.label_hi;
end;
$$;

grant execute on function search_professionals(text,text,text,boolean,int,int) to authenticated;
grant execute on function profession_category_counts() to authenticated;

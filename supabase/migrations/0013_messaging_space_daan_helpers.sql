-- ============================================================================
-- Gahoi Portal — Migration 0013: Messaging + Gahoi Space + Daan Seva helpers
--
-- तीनों नए frontend flows (messages.html, space.html, donate.html) बनाते वक़्त
-- कुछ operations ऐसे मिले जिन्हें client-side "पढ़ो-फिर-लिखो" (read-modify-write)
-- से करना race-condition-prone होता — दो अलग tabs/requests एक साथ चलें तो एक
-- update गुम हो सकता है। इसलिए ये SECURITY DEFINER Postgres functions, जो
-- atomic रूप से (एक ही SQL statement में) काम करते हैं।
-- ============================================================================

-- ── 1. Daan Seva: campaign की raised_amount बढ़ाना ────────────────────────────
-- razorpay-verify-payment के donation-case से बुलाया जाता है। सीधे
-- `update donation_campaigns set raised_amount = raised_amount + X` भी
-- लगभग atomic ही होता (Postgres का UPDATE अपने-आप row-lock लेता है), पर एक
-- named function रखने से भविष्य में validation/notification जोड़ना आसान रहता
-- है, और Edge Function का code साफ़ रहता है।
create or replace function increment_campaign_raised(p_campaign_id uuid, p_amount numeric)
returns void
language sql
security definer
as $$
  update donation_campaigns
  set raised_amount = coalesce(raised_amount, 0) + p_amount
  where id = p_campaign_id;
$$;

-- ── 2. Messaging: दो लोगों के बीच conversation ढूँढना/बनाना ──────────────────
-- `conversations` पर unique(participant_a, participant_b) है, पर participant_a
-- कौन है participant_b कौन — यह तय ना हो तो एक ही जोड़ी के लिए दो अलग-अलग rows
-- (A,B) और (B,A) बन सकती हैं। यह function हमेशा एक तय क्रम (छोटा gahoi_id पहले)
-- में insert करता है, और `on conflict do nothing` + फिर select से race-safe
-- तरीक़े से handle करता है (दो लोग एक साथ पहला message भेजें तो भी सिर्फ़ एक ही
-- conversation बनेगी)।
create or replace function get_or_create_conversation(p_other_gahoi_id text)
returns uuid
language plpgsql
security definer
as $$
declare
  v_me text := current_gahoi_id();
  v_a text;
  v_b text;
  v_id uuid;
begin
  if v_me is null then
    raise exception 'Not authenticated';
  end if;
  if v_me = p_other_gahoi_id then
    raise exception 'Cannot message yourself';
  end if;

  if v_me < p_other_gahoi_id then
    v_a := v_me; v_b := p_other_gahoi_id;
  else
    v_a := p_other_gahoi_id; v_b := v_me;
  end if;

  insert into conversations (participant_a, participant_b)
  values (v_a, v_b)
  on conflict (participant_a, participant_b) do nothing;

  select id into v_id from conversations where participant_a = v_a and participant_b = v_b;
  return v_id;
end;
$$;

-- ── 3. Gahoi Space: like/unlike toggle ────────────────────────────────────────
-- legacy Code.gs के doToggleSpaceLike() जैसा — liked_by text[] array में
-- current_gahoi_id() को add/remove करता है, atomically (कोई दो client एक साथ
-- like करें तो भी count सही रहे)।
create or replace function toggle_space_like(p_post_id uuid)
returns table(liked boolean, like_count int)
language plpgsql
security definer
as $$
declare
  v_me text := current_gahoi_id();
  v_already boolean;
begin
  if v_me is null then
    raise exception 'Not authenticated';
  end if;

  select v_me = any(liked_by) into v_already from space_posts where id = p_post_id;
  if v_already is null then
    raise exception 'Post not found';
  end if;

  if v_already then
    update space_posts set liked_by = array_remove(liked_by, v_me) where id = p_post_id;
  else
    update space_posts set liked_by = array_append(liked_by, v_me) where id = p_post_id;
  end if;

  return query select not v_already, coalesce(array_length(sp.liked_by, 1), 0) from space_posts sp where sp.id = p_post_id;
end;
$$;

-- ── 4. Gahoi Space: comment_count हमेशा सही रहे — trigger से ─────────────────
-- (client से manually increment/decrement करवाना भूलने-योग्य और race-prone
-- दोनों है — insert/soft-delete पर अपने-आप हो जाए तो बेहतर)
create or replace function sync_space_comment_count()
returns trigger
language plpgsql
security definer
as $$
begin
  if TG_OP = 'INSERT' then
    update space_posts set comment_count = coalesce(comment_count, 0) + 1 where id = new.post_id;
  elsif TG_OP = 'UPDATE' and old.status = 'Active' and new.status = 'Deleted' then
    update space_posts set comment_count = greatest(coalesce(comment_count, 1) - 1, 0) where id = new.post_id;
  elsif TG_OP = 'UPDATE' and old.status = 'Deleted' and new.status = 'Active' then
    update space_posts set comment_count = coalesce(comment_count, 0) + 1 where id = new.post_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_sync_space_comment_count on space_comments;
create or replace trigger trg_sync_space_comment_count
  after insert or update on space_comments
  for each row execute function sync_space_comment_count();

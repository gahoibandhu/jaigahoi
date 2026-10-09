-- ============================================================================
-- Gahoi Portal — Migration 0020: Auth support (rate-limit for "User ID bhool gaye" etc.)
-- Anonymous endpoints (find-user-id) par brute-force / enumeration rokne ke liye.
-- Table par koi policy nahi => sirf service role (Edge Function) access kar sakta hai.
-- ============================================================================
create table if not exists auth_rate_limits (
  key          text primary key,
  window_start timestamptz not null default now(),
  hits         int not null default 0
);
alter table auth_rate_limits enable row level security;   -- koi policy nahi: anon/authenticated ko access nahi

-- Atomic: true = allowed, false = limit cross. Window khatam ho to counter reset.
create or replace function auth_rate_check(p_key text, p_max int, p_window_minutes int)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_hits int;
begin
  insert into auth_rate_limits as r (key, window_start, hits) values (p_key, now(), 1)
  on conflict (key) do update
    set window_start = case when r.window_start < now() - make_interval(mins => p_window_minutes) then now() else r.window_start end,
        hits         = case when r.window_start < now() - make_interval(mins => p_window_minutes) then 1 else r.hits + 1 end
  returning hits into v_hits;
  return v_hits <= p_max;
end;
$$;
revoke all on function auth_rate_check(text,int,int) from public, anon, authenticated;
grant execute on function auth_rate_check(text,int,int) to service_role;

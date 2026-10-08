-- =============================================================================
-- Profiles bound to Supabase Auth + role helpers used by RLS and RPCs.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Every new auth user gets a profile with the least-privileged role.
-- Promotion to operator/admin is an explicit admin action.
-- -----------------------------------------------------------------------------
create function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, name, role)
  values (
    new.id,
    coalesce(
      nullif(btrim(new.raw_user_meta_data ->> 'name'), ''),
      nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
      nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
      'Utilizador'
    ),
    'viewer'
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_auth_user();

-- -----------------------------------------------------------------------------
-- Role helpers. SECURITY DEFINER so they can read profiles without recursing
-- into profiles' own RLS policies. They return "no access" for inactive
-- users or users without a profile.
-- -----------------------------------------------------------------------------
create function private.current_app_role()
returns public.app_role
language sql
stable
security definer
set search_path = ''
as $$
  select p.role
  from public.profiles p
  where p.id = (select auth.uid())
    and p.active
$$;

create function private.is_active_user()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.current_app_role() is not null
$$;

create function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(private.current_app_role() = 'admin', false)
$$;

revoke all on all functions in schema private from public;
grant usage on schema private to authenticated;
grant execute on function private.current_app_role() to authenticated;
grant execute on function private.is_active_user() to authenticated;
grant execute on function private.is_admin() to authenticated;

-- -----------------------------------------------------------------------------
-- Never leave the system without an active admin (lock-out protection).
-- -----------------------------------------------------------------------------
create function private.ensure_active_admin_remains()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.role = 'admin' and old.active
     and (new.role <> 'admin' or not new.active) then
    -- Serialize concurrent demotions: lock every active admin row first.
    perform 1 from public.profiles where role = 'admin' and active for update;

    if not exists (
      select 1 from public.profiles
      where role = 'admin' and active and id <> old.id
    ) then
      raise exception using
        errcode = 'P0001',
        message = 'LAST_ADMIN',
        detail  = 'Não é possível remover ou desativar o último administrador ativo.';
    end if;
  end if;
  return new;
end;
$$;

create trigger profiles_ensure_active_admin_remains
  before update of role, active on public.profiles
  for each row execute function private.ensure_active_admin_remains();

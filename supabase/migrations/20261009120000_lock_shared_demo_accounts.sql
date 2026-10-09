-- =============================================================================
-- Locked (shared) accounts: credentials cannot be changed by anyone.
--
-- A public demo shares the read-only viewer credentials. Any signed-in user
-- can call the Auth API directly (PUT /auth/v1/user) to change their own
-- password, e-mail or phone. With e-mail confirmations off, an e-mail change
-- is applied immediately, so a visitor could take the shared account over
-- (new e-mail + password recovery) or lock everyone else out.
--
-- Accounts listed in private.locked_auth_users keep signing in, refreshing
-- and signing out normally, but every change to their credential columns is
-- rejected inside the database, whatever the caller (Auth API, Admin API,
-- dashboard or SQL). The migration is generic: which accounts are locked is
-- operational data, inserted per environment, never committed here.
--
-- Administrative recovery (SQL, as the database owner):
--   delete from private.locked_auth_users where user_id = '<id>';
--   -- change the password/e-mail (dashboard or Admin API), then re-lock:
--   insert into private.locked_auth_users (user_id, reason) values ('<id>', '...');
-- =============================================================================

create table private.locked_auth_users (
  user_id   uuid primary key references auth.users (id) on delete cascade,
  reason    text not null,
  locked_at timestamptz not null default now(),
  constraint locked_auth_users_reason_not_blank check (btrim(reason) <> '' and char_length(reason) <= 200)
);

comment on table private.locked_auth_users is
  'Auth accounts whose credentials (password, e-mail, phone) cannot be changed. Managed only via SQL by the database owner.';

-- Not reachable through the Data API (private schema) and no role but the
-- owner may read or change it; the service_role key cannot unlock accounts.
alter table private.locked_auth_users enable row level security;
revoke all on private.locked_auth_users from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Guard. SECURITY DEFINER so the Auth service role can consult the lock table.
-- Compares only credential columns: sign-in (last_sign_in_at), refresh,
-- sign-out and metadata updates are unaffected.
-- -----------------------------------------------------------------------------
create function private.reject_locked_credential_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (new.encrypted_password is distinct from old.encrypted_password
      or new.email is distinct from old.email
      or new.email_change is distinct from old.email_change
      or new.email_change_token_new is distinct from old.email_change_token_new
      or new.email_change_token_current is distinct from old.email_change_token_current
      or new.phone is distinct from old.phone
      or new.phone_change is distinct from old.phone_change
      or new.phone_change_token is distinct from old.phone_change_token)
     and exists (select 1 from private.locked_auth_users l where l.user_id = old.id) then
    raise exception using
      errcode = '42501',
      message = 'LOCKED_ACCOUNT',
      detail  = 'As credenciais desta conta partilhada não podem ser alteradas.';
  end if;
  return new;
end;
$$;

revoke all on function private.reject_locked_credential_change() from public;

create trigger locked_accounts_reject_credential_change
  before update on auth.users
  for each row execute function private.reject_locked_credential_change();

-- =============================================================================
-- Authorization: table privileges (what an API role may attempt) + RLS
-- policies (which rows it may touch). Both layers are deny-by-default.
--
--   anon      → nothing.
--   viewer    → read everything.
--   operator  → read everything; movements IN/OUT only via the RPC.
--   admin     → read everything; manage master data and profiles;
--               all movement types via the RPC.
--   inactive  → nothing except reading their own profile.
--
-- No role can DELETE anything through the API (soft delete via active=false),
-- and nobody can write to stock_movements directly (RPC only).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Privileges
-- -----------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;

grant select on
  public.categories,
  public.locations,
  public.suppliers,
  public.projects,
  public.products,
  public.profiles,
  public.stock_movements,
  public.product_stock
to authenticated;

-- Master data: admins insert/update (enforced by RLS below). No DELETE grant.
grant insert, update on
  public.categories,
  public.locations,
  public.suppliers,
  public.projects,
  public.products
to authenticated;

-- Profiles are created by the auth trigger; admins may only change these columns.
grant update (name, role, active) on public.profiles to authenticated;

-- Objects created later by migrations must opt in to API access explicitly.
alter default privileges for role postgres in schema public revoke all on tables from anon;
alter default privileges for role postgres in schema public revoke execute on functions from anon;

-- -----------------------------------------------------------------------------
-- Master data tables: read = any active user; write = admin.
-- -----------------------------------------------------------------------------
create policy "categories: active users read" on public.categories
  for select to authenticated using ((select private.is_active_user()));
create policy "categories: admins insert" on public.categories
  for insert to authenticated with check ((select private.is_admin()));
create policy "categories: admins update" on public.categories
  for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));

create policy "locations: active users read" on public.locations
  for select to authenticated using ((select private.is_active_user()));
create policy "locations: admins insert" on public.locations
  for insert to authenticated with check ((select private.is_admin()));
create policy "locations: admins update" on public.locations
  for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));

create policy "suppliers: active users read" on public.suppliers
  for select to authenticated using ((select private.is_active_user()));
create policy "suppliers: admins insert" on public.suppliers
  for insert to authenticated with check ((select private.is_admin()));
create policy "suppliers: admins update" on public.suppliers
  for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));

create policy "projects: active users read" on public.projects
  for select to authenticated using ((select private.is_active_user()));
create policy "projects: admins insert" on public.projects
  for insert to authenticated with check ((select private.is_admin()));
create policy "projects: admins update" on public.projects
  for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));

create policy "products: active users read" on public.products
  for select to authenticated using ((select private.is_active_user()));
create policy "products: admins insert" on public.products
  for insert to authenticated with check ((select private.is_admin()));
create policy "products: admins update" on public.products
  for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));

-- -----------------------------------------------------------------------------
-- Profiles: everyone sees their own row (so the app can explain an inactive
-- account); active users see all profiles (movement "responsible" names);
-- only admins change role/active/name.
-- -----------------------------------------------------------------------------
create policy "profiles: own row or active users read" on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or (select private.is_active_user()));
create policy "profiles: admins update" on public.profiles
  for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

-- -----------------------------------------------------------------------------
-- Ledger: read-only for active users. Inserts only through
-- public.register_stock_movement (SECURITY DEFINER); no update/delete ever.
-- -----------------------------------------------------------------------------
create policy "stock_movements: active users read" on public.stock_movements
  for select to authenticated using ((select private.is_active_user()));

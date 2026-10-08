-- =============================================================================
-- Tralyn — core relational schema
--
-- UUIDs are the technical keys; business codes (INV-201, A-01-01...) are
-- unique, user-visible keys. Stock is NOT stored anywhere in this schema:
-- it is derived from public.stock_movements (see the stock_ledger migration).
--
-- Deletion policy: referenced master data can never be hard-deleted
-- (ON DELETE RESTRICT); records are deactivated with active = false.
-- =============================================================================

-- Internal helpers live in a schema that is NOT exposed through the Data API.
create schema if not exists private;
revoke all on schema private from public;

-- -----------------------------------------------------------------------------
-- Controlled vocabularies
-- -----------------------------------------------------------------------------
create type public.app_role as enum ('admin', 'operator', 'viewer');

create type public.project_status as enum ('active', 'completed', 'cancelled');

-- Quantities are always positive; the type alone defines the effect:
--   + OPENING_BALANCE, IN, ADJUSTMENT_IN
--   − OUT, ADJUSTMENT_OUT
create type public.movement_type as enum (
  'OPENING_BALANCE',
  'IN',
  'OUT',
  'ADJUSTMENT_IN',
  'ADJUSTMENT_OUT'
);

-- OUT_OF_STOCK ("SEM ESTOQUE"): balance <= 0
-- REORDER      ("REPOR"):       0 < balance <= minimum_stock
-- OK:                           balance > minimum_stock
create type public.stock_status as enum ('OUT_OF_STOCK', 'REORDER', 'OK');

-- -----------------------------------------------------------------------------
-- updated_at maintenance
-- -----------------------------------------------------------------------------
create function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- categories
-- -----------------------------------------------------------------------------
create table public.categories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  prefix      text not null,
  description text,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint categories_name_key unique (name),
  constraint categories_prefix_key unique (prefix),
  constraint categories_name_not_blank check (btrim(name) <> ''),
  constraint categories_prefix_format check (prefix ~ '^[A-Z0-9]{2,10}$')
);

create trigger categories_set_updated_at
  before update on public.categories
  for each row execute function private.set_updated_at();

-- -----------------------------------------------------------------------------
-- locations
-- -----------------------------------------------------------------------------
create table public.locations (
  id          uuid primary key default gen_random_uuid(),
  code        text not null,
  zone        text,
  shelf       text,
  position    text,
  description text,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint locations_code_key unique (code),
  constraint locations_code_not_blank check (btrim(code) <> '')
);

create trigger locations_set_updated_at
  before update on public.locations
  for each row execute function private.set_updated_at();

-- -----------------------------------------------------------------------------
-- suppliers
-- -----------------------------------------------------------------------------
create table public.suppliers (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  email          text,
  phone          text,
  contact_person text,
  notes          text,
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint suppliers_name_not_blank check (btrim(name) <> ''),
  constraint suppliers_email_format check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);

-- Suppliers are matched by name (import upsert); avoid case/space duplicates.
create unique index suppliers_name_unique_idx on public.suppliers (lower(btrim(name)));

create trigger suppliers_set_updated_at
  before update on public.suppliers
  for each row execute function private.set_updated_at();

-- -----------------------------------------------------------------------------
-- profiles (1:1 with auth.users; passwords/sessions stay in Supabase Auth)
-- -----------------------------------------------------------------------------
create table public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  name       text not null,
  role       public.app_role not null default 'viewer',
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_name_not_blank check (btrim(name) <> '')
);

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function private.set_updated_at();

-- -----------------------------------------------------------------------------
-- projects (clients/jobs associated with outgoing stock)
-- -----------------------------------------------------------------------------
create table public.projects (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  client     text,
  reference  text,
  status     public.project_status not null default 'active',
  notes      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint projects_reference_key unique (reference),
  constraint projects_name_not_blank check (btrim(name) <> '')
);

create index projects_status_idx on public.projects (status);

create trigger projects_set_updated_at
  before update on public.projects
  for each row execute function private.set_updated_at();

-- -----------------------------------------------------------------------------
-- products (no stock column by design)
-- -----------------------------------------------------------------------------
create table public.products (
  id                  uuid primary key default gen_random_uuid(),
  code                text not null,
  category_id         uuid not null references public.categories (id) on delete restrict,
  brand               text,
  model               text not null,
  specification       text,
  unit                text not null default 'un',
  minimum_stock       integer not null default 0,
  location_id         uuid references public.locations (id) on delete restrict,
  default_supplier_id uuid references public.suppliers (id) on delete restrict,
  qr_code             text,
  active              boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint products_code_key unique (code),
  constraint products_qr_code_key unique (qr_code),
  constraint products_code_format check (code = btrim(code) and code <> ''),
  constraint products_model_not_blank check (btrim(model) <> ''),
  constraint products_unit_not_blank check (btrim(unit) <> ''),
  constraint products_minimum_stock_non_negative check (minimum_stock >= 0)
);

-- FK columns used in joins/filters (products.code is indexed by its unique key).
create index products_category_id_idx on public.products (category_id);
create index products_location_id_idx on public.products (location_id);
create index products_default_supplier_id_idx on public.products (default_supplier_id);
create index products_active_idx on public.products (active);

create trigger products_set_updated_at
  before update on public.products
  for each row execute function private.set_updated_at();

-- -----------------------------------------------------------------------------
-- stock_movements — the append-only ledger (source of truth for stock)
-- -----------------------------------------------------------------------------
create table public.stock_movements (
  id                 uuid primary key default gen_random_uuid(),
  product_id         uuid not null references public.products (id) on delete restrict,
  type               public.movement_type not null,
  quantity           integer not null,
  project_id         uuid references public.projects (id) on delete restrict,
  user_id            uuid not null references public.profiles (id) on delete restrict,
  document_reference text,
  notes              text,
  -- Idempotency key for data migrations (e.g. 'legacy-v2.1:MOVIMENTACOES:2').
  -- Never set by the application RPC.
  source_reference   text,
  created_at         timestamptz not null default now(),
  constraint stock_movements_quantity_positive check (quantity > 0),
  constraint stock_movements_source_reference_key unique (source_reference),
  constraint stock_movements_document_reference_length check (char_length(document_reference) <= 120),
  constraint stock_movements_notes_length check (char_length(notes) <= 1000)
);

create index stock_movements_product_id_created_at_idx
  on public.stock_movements (product_id, created_at);
create index stock_movements_created_at_idx on public.stock_movements (created_at desc);
create index stock_movements_project_id_idx on public.stock_movements (project_id);
create index stock_movements_user_id_idx on public.stock_movements (user_id);
create index stock_movements_type_idx on public.stock_movements (type);

-- A product has at most one opening balance.
create unique index stock_movements_one_opening_balance_idx
  on public.stock_movements (product_id)
  where type = 'OPENING_BALANCE';

-- -----------------------------------------------------------------------------
-- RLS on from the very first moment; policies come in a later migration.
-- -----------------------------------------------------------------------------
alter table public.categories      enable row level security;
alter table public.locations       enable row level security;
alter table public.suppliers       enable row level security;
alter table public.profiles        enable row level security;
alter table public.projects        enable row level security;
alter table public.products        enable row level security;
alter table public.stock_movements enable row level security;

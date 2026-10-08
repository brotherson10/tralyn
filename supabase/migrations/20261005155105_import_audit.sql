-- =============================================================================
-- Import audit trail: import_batches + import_records
--
-- Data migrations (e.g. a legacy spreadsheet) run as ONE PostgreSQL
-- transaction over a direct database connection, outside the application:
--   * failure  → ROLLBACK → neither the batch nor its records exist;
--   * COMMIT   → the batch represents a completed import.
-- Therefore a batch has a single immutable timestamp (imported_at). now()
-- returns the transaction start time, so all rows of one import share it.
--
-- Both tables are append-only audit history: UPDATE, DELETE and TRUNCATE are
-- rejected. Admins can read them through the API; nobody writes through it.
-- No existing table is altered.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- import_batches: one row per committed import
-- -----------------------------------------------------------------------------
create table public.import_batches (
  id             uuid primary key default gen_random_uuid(),
  -- Logical file name only (e.g. 'inventory.xlsx'),
  -- never a local path.
  source_file    text not null,
  source_sha256  text not null,
  import_version text not null,
  imported_at    timestamptz not null default now(),
  -- Profile on whose behalf the import ran (the technical import account).
  executed_by    uuid references public.profiles (id) on delete restrict,
  -- Reconciliation report (counts, totals, warnings). Never secrets.
  summary        jsonb not null default '{}'::jsonb,
  constraint import_batches_source_file_name check (
    btrim(source_file) <> ''
    and source_file = btrim(source_file)
    and char_length(source_file) <= 255
    and source_file !~ '[/\\]'
    and source_file !~ '^[A-Za-z]:'
  ),
  constraint import_batches_source_sha256_format check (source_sha256 ~ '^[0-9a-f]{64}$'),
  constraint import_batches_import_version_not_blank check (
    btrim(import_version) <> '' and char_length(import_version) <= 50
  ),
  constraint import_batches_summary_is_object check (jsonb_typeof(summary) = 'object')
);

create index import_batches_imported_at_idx on public.import_batches (imported_at desc);
create index import_batches_source_sha256_idx on public.import_batches (source_sha256);
create index import_batches_executed_by_idx on public.import_batches (executed_by);

comment on table public.import_batches is
  'Append-only audit of committed data imports. One row per successful import transaction.';

-- -----------------------------------------------------------------------------
-- import_records: one row per source item handled by a batch
-- -----------------------------------------------------------------------------
create table public.import_records (
  id               uuid primary key default gen_random_uuid(),
  batch_id         uuid not null references public.import_batches (id) on delete restrict,
  entity_type      text not null,
  -- Every supported action refers to a real entity. A future action without
  -- an entity would require an explicit migration relaxing this column.
  entity_id        uuid not null,
  -- Deterministic identifier of the source item, stable across runs
  -- (e.g. 'tralyn-demo:product:INV-201', 'tralyn-demo:opening:INV-201').
  source_reference text not null,
  source_sheet     text not null,
  source_row       integer,
  action           text not null,
  -- Normalized snapshot of the source item (e.g. the legacy "Responsável"
  -- text). Never passwords, tokens, connection strings or other secrets.
  source_data      jsonb not null,
  created_at       timestamptz not null default now(),
  constraint import_records_entity_type_allowed check (
    entity_type in ('category', 'location', 'product', 'stock_movement')
  ),
  constraint import_records_action_allowed check (action in ('created', 'already_present')),
  constraint import_records_source_reference_format check (
    btrim(source_reference) <> ''
    and source_reference = btrim(source_reference)
    and char_length(source_reference) <= 300
  ),
  constraint import_records_source_sheet_not_blank check (
    btrim(source_sheet) <> '' and char_length(source_sheet) <= 100
  ),
  constraint import_records_source_row_positive check (source_row is null or source_row > 0),
  constraint import_records_source_data_is_object check (jsonb_typeof(source_data) = 'object')
);

comment on table public.import_records is
  'Append-only audit of each source item handled by an import batch.';
comment on column public.import_records.entity_id is
  'Id of the affected row in the table given by entity_type (categories, locations, products, stock_movements). '
  'Intentionally without a foreign key: a single column cannot reference several tables, and a fake polymorphic '
  'FK would not be enforced. Referenced rows cannot be deleted anyway (soft delete / immutable ledger).';

-- Idempotency:
-- * within a batch, each (entity_type, source_reference) is recorded once;
create unique index import_records_batch_item_key
  on public.import_records (batch_id, entity_type, source_reference);
-- * across ALL batches, an item can be "created" only once. Re-runs record
--   'already_present' for the same reference, preserving the history of
--   attempts without ever creating the entity twice.
create unique index import_records_created_once_key
  on public.import_records (entity_type, source_reference)
  where action = 'created';
-- Lookup: "which import created / touched this product?"
create index import_records_entity_idx on public.import_records (entity_type, entity_id);

-- -----------------------------------------------------------------------------
-- Immutability (own function: the ledger's message would be misleading here;
-- the stock_movements protection is not touched)
-- -----------------------------------------------------------------------------
create function private.reject_import_audit_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using
    errcode = 'P0001',
    message = 'IMMUTABLE_IMPORT_AUDIT',
    detail  = 'O histórico de importações não pode ser alterado nem apagado.';
end;
$$;

revoke all on function private.reject_import_audit_change() from public;

create trigger import_batches_immutable_rows
  before update or delete on public.import_batches
  for each row execute function private.reject_import_audit_change();
create trigger import_batches_immutable_truncate
  before truncate on public.import_batches
  for each statement execute function private.reject_import_audit_change();

create trigger import_records_immutable_rows
  before update or delete on public.import_records
  for each row execute function private.reject_import_audit_change();
create trigger import_records_immutable_truncate
  before truncate on public.import_records
  for each statement execute function private.reject_import_audit_change();

-- -----------------------------------------------------------------------------
-- Privileges + RLS: admins read; nobody writes through the API.
-- New tables in public get default grants for authenticated and service_role,
-- so they are revoked explicitly. Imports write over a direct connection as
-- the table owner.
-- -----------------------------------------------------------------------------
revoke all on public.import_batches, public.import_records from anon, authenticated, service_role;
grant select on public.import_batches, public.import_records to authenticated;

alter table public.import_batches enable row level security;
alter table public.import_records enable row level security;

create policy "import_batches: admins read" on public.import_batches
  for select to authenticated using ((select private.is_admin()));
create policy "import_records: admins read" on public.import_records
  for select to authenticated using ((select private.is_admin()));

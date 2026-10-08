-- =============================================================================
-- Stock ledger rules
--
--   balance = Σ OPENING_BALANCE + Σ IN + Σ ADJUSTMENT_IN − Σ OUT − Σ ADJUSTMENT_OUT
--
-- 1. stock_movements is append-only: UPDATE/DELETE/TRUNCATE are rejected for
--    every role, including the service role. Corrections are new movements.
-- 2. Negative balances are rejected by a BEFORE INSERT trigger, so the rule
--    holds for every insertion path (application RPC and data import).
-- 3. Concurrency: every insert locks the product row (SELECT ... FOR UPDATE)
--    before reading the balance, so movements of the same product are
--    serialized and two concurrent outputs can never both spend the same unit.
-- =============================================================================

create function private.movement_sign(p_type public.movement_type)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case
    when p_type in ('OPENING_BALANCE', 'IN', 'ADJUSTMENT_IN') then 1
    else -1
  end
$$;

-- -----------------------------------------------------------------------------
-- Immutability
-- -----------------------------------------------------------------------------
create function private.reject_ledger_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using
    errcode = 'P0001',
    message = 'IMMUTABLE_LEDGER',
    detail  = 'Movimentações não podem ser alteradas nem apagadas. Registe uma nova movimentação de ajuste.';
end;
$$;

create trigger stock_movements_immutable_rows
  before update or delete on public.stock_movements
  for each row execute function private.reject_ledger_change();

create trigger stock_movements_immutable_truncate
  before truncate on public.stock_movements
  for each statement execute function private.reject_ledger_change();

-- -----------------------------------------------------------------------------
-- Non-negative balance + serialization per product
-- -----------------------------------------------------------------------------
create function private.enforce_non_negative_balance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_balance integer;
begin
  -- Row lock on the product: concurrent inserts for the same product wait
  -- here until the previous transaction commits or rolls back.
  perform 1 from public.products where id = new.product_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'PRODUCT_NOT_FOUND';
  end if;

  if private.movement_sign(new.type) < 0 then
    -- Read after acquiring the lock: under READ COMMITTED this statement
    -- sees every movement committed by transactions that held the lock.
    select coalesce(sum(private.movement_sign(m.type) * m.quantity), 0)
      into v_balance
      from public.stock_movements m
     where m.product_id = new.product_id;

    if v_balance - new.quantity < 0 then
      raise exception using
        errcode = 'P0001',
        message = 'INSUFFICIENT_STOCK',
        detail  = format('Saldo disponível: %s. Quantidade pedida: %s.', v_balance, new.quantity),
        hint    = v_balance::text;
    end if;
  end if;

  return new;
end;
$$;

create trigger stock_movements_enforce_non_negative_balance
  before insert on public.stock_movements
  for each row execute function private.enforce_non_negative_balance();

-- -----------------------------------------------------------------------------
-- Reusable balance/status per product (dashboard, listings, detail page).
-- security_invoker: the caller's RLS applies to every underlying table.
-- -----------------------------------------------------------------------------
create view public.product_stock
with (security_invoker = true)
as
select
  p.id,
  p.code,
  p.category_id,
  c.name   as category_name,
  c.prefix as category_prefix,
  p.brand,
  p.model,
  p.specification,
  p.unit,
  p.minimum_stock,
  p.location_id,
  l.code   as location_code,
  p.default_supplier_id,
  s.name   as supplier_name,
  p.qr_code,
  p.active,
  p.created_at,
  p.updated_at,
  coalesce(b.balance, 0)::integer as balance,
  (case
     when coalesce(b.balance, 0) <= 0 then 'OUT_OF_STOCK'
     when coalesce(b.balance, 0) <= p.minimum_stock then 'REORDER'
     else 'OK'
   end)::public.stock_status as status,
  b.last_movement_at
from public.products p
join public.categories c on c.id = p.category_id
left join public.locations l on l.id = p.location_id
left join public.suppliers s on s.id = p.default_supplier_id
left join (
  select
    m.product_id,
    sum(case when m.type in ('OPENING_BALANCE', 'IN', 'ADJUSTMENT_IN')
             then m.quantity else -m.quantity end) as balance,
    max(m.created_at) as last_movement_at
  from public.stock_movements m
  group by m.product_id
) b on b.product_id = p.id;

-- -----------------------------------------------------------------------------
-- RPC: the only way the application records a movement.
--
-- * Responsible user = auth.uid() (never a client parameter).
-- * Timestamp = database now() (never the browser clock).
-- * Permissions: admin → all types; operator → IN, OUT; viewer/inactive → none.
-- Errors use machine-readable messages (INSUFFICIENT_STOCK, FORBIDDEN, ...)
-- that the server maps to user-facing text.
-- -----------------------------------------------------------------------------
create function public.register_stock_movement(
  p_product_id         uuid,
  p_type               public.movement_type,
  p_quantity           integer,
  p_project_id         uuid default null,
  p_document_reference text default null,
  p_notes              text default null
)
returns table (movement_id uuid, movement_created_at timestamptz, balance_after integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_role    public.app_role;
  v_active  boolean;
  v_project public.project_status;
  v_id      uuid;
  v_created timestamptz;
  v_balance integer;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'NOT_AUTHENTICATED';
  end if;

  v_role := private.current_app_role();
  if v_role is null
     or v_role = 'viewer'
     or (v_role = 'operator' and p_type not in ('IN', 'OUT')) then
    raise exception using
      errcode = '42501',
      message = 'FORBIDDEN',
      detail  = 'O seu perfil não permite registar este tipo de movimentação.';
  end if;

  if p_product_id is null or p_type is null then
    raise exception using errcode = '22023', message = 'INVALID_INPUT';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception using errcode = '22023', message = 'INVALID_QUANTITY',
      detail = 'A quantidade deve ser um número inteiro positivo.';
  end if;

  -- Lock first (same lock the insert trigger takes; re-entrant in this tx).
  select p.active into v_active
    from public.products p
   where p.id = p_product_id
     for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'PRODUCT_NOT_FOUND';
  end if;
  if not v_active then
    raise exception using errcode = 'P0001', message = 'PRODUCT_INACTIVE',
      detail = 'Não é possível movimentar um produto desativado.';
  end if;

  if p_project_id is not null then
    select pr.status into v_project from public.projects pr where pr.id = p_project_id;
    if not found then
      raise exception using errcode = 'P0001', message = 'PROJECT_NOT_FOUND';
    end if;
    if v_project <> 'active' then
      raise exception using errcode = 'P0001', message = 'PROJECT_NOT_ACTIVE';
    end if;
  end if;

  begin
    insert into public.stock_movements
      (product_id, type, quantity, project_id, user_id, document_reference, notes)
    values
      (p_product_id, p_type, p_quantity, p_project_id, v_user_id,
       nullif(btrim(p_document_reference), ''), nullif(btrim(p_notes), ''))
    returning id, created_at into v_id, v_created;
  exception
    when unique_violation then
      raise exception using errcode = 'P0001', message = 'OPENING_BALANCE_EXISTS',
        detail = 'Este produto já tem saldo inicial registado. Use um ajuste.';
  end;

  select coalesce(sum(private.movement_sign(m.type) * m.quantity), 0)::integer
    into v_balance
    from public.stock_movements m
   where m.product_id = p_product_id;

  return query select v_id, v_created, v_balance;
end;
$$;

revoke all on function public.register_stock_movement(uuid, public.movement_type, integer, uuid, text, text) from public, anon;
grant execute on function public.register_stock_movement(uuid, public.movement_type, integer, uuid, text, text) to authenticated;

-- Helpers in the private schema are not callable by API roles.
revoke all on all functions in schema private from public;
grant execute on function private.current_app_role() to authenticated;
grant execute on function private.is_active_user() to authenticated;
grant execute on function private.is_admin() to authenticated;

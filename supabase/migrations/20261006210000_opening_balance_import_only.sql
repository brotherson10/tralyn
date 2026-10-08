-- =============================================================================
-- OPENING_BALANCE is reserved for the technical initial import.
--
-- The operational RPC register_stock_movement used to accept OPENING_BALANCE
-- from admins (the UI never offered it). Domain decision: opening balances
-- belong exclusively to the data migration, which writes the ledger directly
-- in its own audited transaction (scripts/inventory-import). A product created
-- operationally starts at 0 and receives stock through IN movements.
--
-- Only the authorization condition changes (OPENING_BALANCE → FORBIDDEN for
-- every role). Signature, SECURITY DEFINER, search_path, grants, locking,
-- validations, user_id = auth.uid() and created_at = now() are unchanged.
-- Existing OPENING_BALANCE rows, the enum value and the one-per-product index
-- are untouched.
-- =============================================================================

create or replace function public.register_stock_movement(
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
     or (v_role = 'operator' and p_type not in ('IN', 'OUT'))
     -- Opening balances only come from the technical import (direct ledger insert).
     or p_type = 'OPENING_BALANCE' then
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

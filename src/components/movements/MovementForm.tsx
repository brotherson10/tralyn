"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { StockStatusBadge } from "@/components/ui/Badge";
import { buttonClass } from "@/components/ui/Button";
import { INITIAL_FORM_STATE, type FormState } from "@/lib/forms";
import { checkMovement, isAdjustment, MOVEMENT_TYPE_LABELS, type OperationalMovementType } from "@/lib/stock/ledger";
import type { MovementFormProduct, MovementFormProject } from "@/services/movements";
import { MOVEMENT_TYPE_DESCRIPTIONS, movementEffectLabel, MovementTypeBadge } from "./MovementDisplay";

interface MovementFormProps {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  products: MovementFormProduct[];
  projects: MovementFormProject[];
  allowedTypes: OperationalMovementType[];
  initialProductId?: string | null;
}

const inputClass =
  "mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30 aria-[invalid=true]:border-red-500";

const productOptionLabel = (p: MovementFormProduct) =>
  `${p.code} — ${[p.brand, p.model].filter(Boolean).join(" ")}${p.specification ? ` (${p.specification})` : ""}`;

/**
 * Operational movement form. It only collects what the RPC accepts; the
 * responsible user and timestamp come from the database session. The balance
 * preview is informative only: the database decides (locks + triggers).
 */
export default function MovementForm(props: MovementFormProps) {
  const [state, formAction, pending] = useActionState(props.action, INITIAL_FORM_STATE);
  const error = state.status === "error" ? state : null;
  // Re-mount with the submitted values after a failed attempt.
  const version = error ? JSON.stringify(error.values ?? {}) : "initial";
  return <MovementFormBody key={version} {...props} formAction={formAction} pending={pending} error={error} />;
}

function MovementFormBody({
  products,
  projects,
  allowedTypes,
  initialProductId,
  formAction,
  pending,
  error,
}: MovementFormProps & {
  formAction: (formData: FormData) => void;
  pending: boolean;
  error: Extract<FormState, { status: "error" }> | null;
}) {
  const initial = error?.values ?? {};
  const [productId, setProductId] = useState(initial.product_id ?? initialProductId ?? "");
  const [type, setType] = useState<string>(initial.type ?? (allowedTypes.length === 1 ? allowedTypes[0] : ""));
  const [quantity, setQuantity] = useState(initial.quantity ?? "");
  const product = products.find((p) => p.id === productId) ?? null;

  const selectedType = (allowedTypes as string[]).includes(type) ? (type as OperationalMovementType) : null;
  const adjustment = selectedType ? isAdjustment(selectedType) : false;
  const qty = Number(quantity);
  const preview =
    product && selectedType && Number.isInteger(qty) && qty > 0 ? checkMovement(product.balance ?? 0, selectedType, qty) : null;

  const fieldError = (name: string) => error?.fieldErrors?.[name];
  const regular = allowedTypes.filter((t) => !isAdjustment(t));
  const adjustments = allowedTypes.filter((t) => isAdjustment(t));

  const typeOption = (t: OperationalMovementType) => (
    <label
      key={t}
      className={`flex cursor-pointer items-start gap-3 rounded-lg p-3 ${
        isAdjustment(t) ? "border border-dashed border-amber-400" : "border border-slate-200"
      } ${type === t ? "bg-brand-subtle ring-2 ring-brand" : "bg-white hover:bg-slate-50"}`}
    >
      <input
        type="radio"
        name="type"
        value={t}
        checked={type === t}
        onChange={() => setType(t)}
        disabled={pending}
        className="mt-1 h-4 w-4 accent-brand"
      />
      <span>
        <MovementTypeBadge type={t} />
        <span className="mt-1 block text-xs text-slate-600">{MOVEMENT_TYPE_DESCRIPTIONS[t]}</span>
      </span>
    </label>
  );

  return (
    <form action={formAction} noValidate aria-busy={pending} className="max-w-3xl space-y-6">
      {error && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error.message}
        </div>
      )}

      {/* Product */}
      <fieldset className="rounded-lg border border-slate-200 bg-white p-5">
        <legend className="px-1 text-sm font-semibold text-slate-900">Produto</legend>
        <label htmlFor="product_id" className="block text-sm font-medium text-slate-800">
          Produto <span className="text-red-700" aria-hidden="true">*</span>
        </label>
        <select
          id="product_id"
          name="product_id"
          value={productId}
          onChange={(event) => setProductId(event.target.value)}
          required
          disabled={pending}
          aria-invalid={fieldError("product_id") ? true : undefined}
          aria-describedby={fieldError("product_id") ? "product_id-error" : "product_id-hint"}
          className={inputClass}
        >
          <option value="">Selecione o produto…</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>
              {productOptionLabel(p)}
            </option>
          ))}
        </select>
        <p id="product_id-hint" className="mt-1 text-xs text-slate-500">
          Só produtos ativos podem receber movimentações.
        </p>
        {fieldError("product_id") && (
          <p id="product_id-error" className="mt-1 text-sm text-red-700">
            {fieldError("product_id")}
          </p>
        )}

        {product && (
          <dl className="mt-4 grid grid-cols-2 gap-3 rounded-md bg-slate-50 p-3 text-sm sm:grid-cols-4" data-testid="product-context">
            <div>
              <dt className="text-xs text-slate-500">Código</dt>
              <dd className="font-mono font-semibold">{product.code}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Stock atual</dt>
              <dd className="font-semibold tabular-nums" data-testid="context-balance">
                {product.balance} {product.unit}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Stock mínimo</dt>
              <dd className="tabular-nums">{product.minimum_stock}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Status</dt>
              <dd>
                <StockStatusBadge status={product.status} />
              </dd>
            </div>
            <p className="col-span-2 text-xs text-slate-500 sm:col-span-4">
              Valores no momento em que a página foi aberta. O saldo final é sempre confirmado pela base de dados.
            </p>
          </dl>
        )}
      </fieldset>

      {/* Type */}
      <fieldset
        className="rounded-lg border border-slate-200 bg-white p-5"
        aria-describedby={fieldError("type") ? "type-error" : undefined}
      >
        <legend className="px-1 text-sm font-semibold text-slate-900">
          Tipo de movimentação <span className="text-red-700" aria-hidden="true">*</span>
        </legend>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{regular.map(typeOption)}</div>
        {adjustments.length > 0 && (
          <>
            <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-amber-800">
              Ajustes de inventário (correções)
            </p>
            <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">{adjustments.map(typeOption)}</div>
          </>
        )}
        {fieldError("type") && (
          <p id="type-error" className="mt-2 text-sm text-red-700">
            {fieldError("type")}
          </p>
        )}
      </fieldset>

      {/* Details */}
      <fieldset className="grid grid-cols-1 gap-5 rounded-lg border border-slate-200 bg-white p-5 sm:grid-cols-2">
        <legend className="px-1 text-sm font-semibold text-slate-900">Detalhes</legend>
        <div>
          <label htmlFor="quantity" className="block text-sm font-medium text-slate-800">
            Quantidade <span className="text-red-700" aria-hidden="true">*</span>
            {selectedType && <span className="font-normal text-slate-500"> ({movementEffectLabel(selectedType)})</span>}
          </label>
          <input
            id="quantity"
            name="quantity"
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
            required
            disabled={pending}
            aria-invalid={fieldError("quantity") ? true : undefined}
            aria-describedby="quantity-hint quantity-preview quantity-error"
            className={inputClass}
          />
          <p id="quantity-hint" className="mt-1 text-xs text-slate-500">
            Sempre um número positivo. O tipo define se o stock aumenta ou diminui.
          </p>
          <p id="quantity-preview" className="mt-1 text-xs" aria-live="polite">
            {preview?.ok && (
              <span className="text-slate-600">
                Saldo previsto após o registo: <strong>{preview.resultingBalance} {product?.unit}</strong>
              </span>
            )}
            {preview && !preview.ok && preview.reason === "INSUFFICIENT_STOCK" && (
              <span className="font-medium text-amber-800">
                Atenção: a quantidade excede o stock disponível ({preview.available} {product?.unit}). A base de dados
                vai recusar este registo.
              </span>
            )}
          </p>
          {fieldError("quantity") && (
            <p id="quantity-error" className="mt-1 text-sm text-red-700">
              {fieldError("quantity")}
            </p>
          )}
        </div>

        <div>
          <label htmlFor="project_id" className="block text-sm font-medium text-slate-800">
            Projeto <span className="font-normal text-slate-500">(opcional)</span>
          </label>
          <select
            id="project_id"
            name="project_id"
            defaultValue={initial.project_id ?? ""}
            disabled={pending}
            aria-invalid={fieldError("project_id") ? true : undefined}
            aria-describedby={fieldError("project_id") ? "project_id-error" : "project_id-hint"}
            className={inputClass}
          >
            <option value="">— Sem projeto —</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
                {project.reference ? ` (${project.reference})` : ""}
              </option>
            ))}
          </select>
          <p id="project_id-hint" className="mt-1 text-xs text-slate-500">
            Só projetos ativos. Recomendado nas saídas para obra/cliente.
          </p>
          {fieldError("project_id") && (
            <p id="project_id-error" className="mt-1 text-sm text-red-700">
              {fieldError("project_id")}
            </p>
          )}
        </div>

        <div className="sm:col-span-2">
          <label htmlFor="document_reference" className="block text-sm font-medium text-slate-800">
            Referência / documento <span className="font-normal text-slate-500">(opcional)</span>
          </label>
          <input
            id="document_reference"
            name="document_reference"
            maxLength={120}
            defaultValue={initial.document_reference ?? ""}
            placeholder="Ex.: guia de remessa, fatura, requisição"
            disabled={pending}
            aria-invalid={fieldError("document_reference") ? true : undefined}
            className={inputClass}
          />
          {fieldError("document_reference") && (
            <p className="mt-1 text-sm text-red-700">{fieldError("document_reference")}</p>
          )}
        </div>

        <div className="sm:col-span-2">
          <label htmlFor="notes" className="block text-sm font-medium text-slate-800">
            Observações{" "}
            {adjustment ? (
              <span className="text-red-700">* (motivo do ajuste, obrigatório)</span>
            ) : (
              <span className="font-normal text-slate-500">(opcional)</span>
            )}
          </label>
          <textarea
            id="notes"
            name="notes"
            rows={3}
            maxLength={1000}
            defaultValue={initial.notes ?? ""}
            required={adjustment}
            disabled={pending}
            placeholder={adjustment ? "Ex.: Contagem física encontrou 2 unidades adicionais." : undefined}
            aria-invalid={fieldError("notes") ? true : undefined}
            aria-describedby={fieldError("notes") ? "notes-error" : undefined}
            className={inputClass}
          />
          {fieldError("notes") && (
            <p id="notes-error" className="mt-1 text-sm text-red-700">
              {fieldError("notes")}
            </p>
          )}
        </div>
      </fieldset>

      <p className="text-xs text-slate-500">
        O responsável e a data/hora são registados automaticamente pela base de dados. Movimentações não podem ser
        editadas nem apagadas; erros corrigem-se com um ajuste.
      </p>

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Link href="/movimentacoes" className={buttonClass("secondary")}>
          Cancelar
        </Link>
        <button type="submit" disabled={pending} className={buttonClass("primary", "sm:min-w-56")}>
          {pending
            ? "A registar…"
            : selectedType
              ? `Registar ${MOVEMENT_TYPE_LABELS[selectedType].toLowerCase()}`
              : "Registar movimentação"}
        </button>
      </div>
    </form>
  );
}

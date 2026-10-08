import type { FieldDef } from "@/lib/forms";
import { PROJECT_STATUSES, PROJECT_STATUS_LABELS } from "@/validation/master-data";

/**
 * Form field definitions shared by the form UI and the Server Actions (which
 * only read these keys from the submitted FormData).
 */

export const CATEGORY_FIELDS: readonly FieldDef[] = [
  { name: "name", label: "Nome", required: true, maxLength: 60, placeholder: "Ex.: Inverters" },
  {
    name: "prefix",
    label: "Prefixo",
    required: true,
    maxLength: 10,
    uppercase: true,
    placeholder: "Ex.: INV",
    hint: "2 a 10 letras ou números. Será usado nos códigos dos produtos desta categoria.",
  },
  { name: "description", label: "Descrição", type: "textarea", maxLength: 300, wide: true },
];

export const LOCATION_FIELDS: readonly FieldDef[] = [
  {
    name: "code",
    label: "Código",
    required: true,
    maxLength: 40,
    placeholder: "Ex.: A-01-01",
    hint: "Identificador único da posição no armazém.",
  },
  { name: "zone", label: "Zona / estante", maxLength: 40, placeholder: "Ex.: A" },
  { name: "shelf", label: "Prateleira", maxLength: 20, placeholder: "Ex.: 01" },
  { name: "position", label: "Posição", maxLength: 20, placeholder: "Ex.: 01" },
  { name: "description", label: "Descrição", type: "textarea", maxLength: 300, wide: true },
];

export const SUPPLIER_FIELDS: readonly FieldDef[] = [
  { name: "name", label: "Nome", required: true, maxLength: 120, autoComplete: "organization", wide: true },
  { name: "contact_person", label: "Pessoa de contacto", maxLength: 120, autoComplete: "off" },
  { name: "email", label: "Email", type: "email", maxLength: 254, autoComplete: "off" },
  { name: "phone", label: "Telefone", type: "tel", maxLength: 30, autoComplete: "off", placeholder: "Ex.: +351 210 000 000" },
  { name: "notes", label: "Observações", type: "textarea", maxLength: 1000, wide: true },
];

export const PROJECT_FIELDS: readonly FieldDef[] = [
  { name: "name", label: "Nome", required: true, maxLength: 120, wide: true },
  { name: "client", label: "Cliente", maxLength: 120 },
  { name: "reference", label: "Referência", maxLength: 60, hint: "Opcional. Se indicada, tem de ser única." },
  {
    name: "status",
    label: "Estado",
    type: "select",
    required: true,
    options: PROJECT_STATUSES.map((value) => ({ value, label: PROJECT_STATUS_LABELS[value] })),
  },
  { name: "notes", label: "Observações", type: "textarea", maxLength: 1000, wide: true },
];

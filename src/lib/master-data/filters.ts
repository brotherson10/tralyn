import { PROJECT_STATUSES, PROJECT_STATUS_LABELS } from "@/validation/master-data";

/** Options for the "Estado" filter (the first option is the default). */
export const ACTIVE_FILTER_OPTIONS = {
  feminine: [
    { value: "todos", label: "Todas" },
    { value: "ativos", label: "Ativas" },
    { value: "inativos", label: "Inativas" },
  ],
  masculine: [
    { value: "todos", label: "Todos" },
    { value: "ativos", label: "Ativos" },
    { value: "inativos", label: "Inativos" },
  ],
} as const;

export const PROJECT_STATUS_FILTER_OPTIONS = [
  { value: "todos", label: "Todos" },
  ...PROJECT_STATUSES.map((value) => ({ value, label: PROJECT_STATUS_LABELS[value] })),
] as const;

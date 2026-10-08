import type { FriendlyError } from "@/lib/db/errors";

/**
 * Maps errors raised by public.register_stock_movement (and the ledger
 * triggers/constraints) to Portuguese messages. The RPC raises
 * machine-readable messages (INSUFFICIENT_STOCK, FORBIDDEN, ...); anything
 * unknown gets a neutral message instead of a guess.
 */

export interface RpcErrorLike {
  code?: string;
  message?: string;
  hint?: string | null;
}

export const MOVEMENT_UNEXPECTED_ERROR =
  "Não foi possível registar a movimentação. Nada foi alterado. Tente novamente ou contacte o administrador.";

export function movementErrorMessage(error: RpcErrorLike, unit = "un"): FriendlyError {
  switch (error.message) {
    case "INSUFFICIENT_STOCK": {
      const available = Number(error.hint);
      const text = Number.isFinite(available)
        ? `Stock insuficiente. Disponível: ${available} ${unit}.`
        : "Stock insuficiente para esta saída.";
      return { message: text, fieldErrors: { quantity: text } };
    }
    case "PRODUCT_INACTIVE":
      return {
        message: "Este produto está inativo e não pode receber movimentações.",
        fieldErrors: { product_id: "Produto inativo. Reative-o antes de registar movimentações." },
      };
    case "PRODUCT_NOT_FOUND":
      return { message: "O produto escolhido não existe.", fieldErrors: { product_id: "O produto escolhido não existe." } };
    case "PROJECT_NOT_FOUND":
      return { message: "O projeto escolhido não existe.", fieldErrors: { project_id: "O projeto escolhido não existe." } };
    case "PROJECT_NOT_ACTIVE":
      return {
        message: "Só projetos ativos podem ser associados a movimentações.",
        fieldErrors: { project_id: "Este projeto está concluído ou cancelado. Escolha um projeto ativo." },
      };
    case "INVALID_QUANTITY":
      return {
        message: "Quantidade inválida.",
        fieldErrors: { quantity: "A quantidade tem de ser um número inteiro maior que zero." },
      };
    case "INVALID_INPUT":
      return { message: "Dados da movimentação incompletos." };
    case "FORBIDDEN":
      return {
        message: "O seu perfil não permite registar este tipo de movimentação.",
        fieldErrors: { type: "Tipo de movimentação não permitido para o seu perfil." },
      };
    case "NOT_AUTHENTICATED":
      return { message: "A sua sessão terminou. Inicie sessão novamente." };
    case "OPENING_BALANCE_EXISTS":
      return { message: "Este produto já tem saldo inicial registado." };
  }

  switch (error.code) {
    case "22P02":
      return { message: "Tipo de movimentação inválido.", fieldErrors: { type: "Tipo de movimentação inválido." } };
    case "23514":
      return { message: "Alguns dados excedem o tamanho permitido (referência até 120, observações até 1000 caracteres)." };
    case "42501":
      return { message: "Não tem permissão para registar movimentações." };
    default:
      return { message: MOVEMENT_UNEXPECTED_ERROR };
  }
}

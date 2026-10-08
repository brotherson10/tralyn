"use client";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-6">
      <h2 className="font-semibold text-red-900">Não foi possível carregar esta página.</h2>
      <p className="mt-1 text-sm text-red-800">
        Tente novamente. Se o problema persistir, contacte o administrador
        {error.digest ? ` indicando a referência ${error.digest}` : ""}.
      </p>
      <button
        type="button"
        onClick={reset}
        className="mt-4 rounded-md bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-800"
      >
        Tentar novamente
      </button>
    </div>
  );
}

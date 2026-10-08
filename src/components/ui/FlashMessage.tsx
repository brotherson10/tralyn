/**
 * Success feedback after a redirect (?sucesso=<key>). Only fixed messages
 * from `messages` are shown, so the query string cannot inject text.
 */
export default function FlashMessage({ value, messages }: { value: unknown; messages: Record<string, string> }) {
  if (typeof value !== "string" || !Object.hasOwn(messages, value)) return null;
  return (
    <div role="status" className="mb-4 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
      {messages[value]}
    </div>
  );
}

export interface ShellUser {
  name: string;
  roleLabel: string;
}

export default function UserSummary({ user, tone = "light" }: { user: ShellUser; tone?: "light" | "dark" }) {
  return (
    <div className="min-w-0 text-right leading-tight" data-testid="current-user">
      <p className={`truncate text-sm font-semibold ${tone === "dark" ? "text-white" : "text-slate-900"}`}>
        {user.name}
      </p>
      <p className={`text-xs ${tone === "dark" ? "text-slate-400" : "text-slate-500"}`}>{user.roleLabel}</p>
    </div>
  );
}

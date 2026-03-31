import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import {
  RESIDENT_REJECTED_KEY,
  RESIDENT_REJECTION_REASON_KEY,
  useAuth,
  UserRole,
} from "@/contexts/AuthContext";
import { ShieldCheck, Users, Loader2, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

export default function Login() {
  const { login, loading, isAuthenticated, user } = useAuth();
  const navigate = useNavigate();
  const [role, setRole] = useState<UserRole>("resident");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const rejected = window.sessionStorage.getItem(RESIDENT_REJECTED_KEY);
    if (!rejected) return;
    const rejectionReason = window.sessionStorage.getItem(RESIDENT_REJECTION_REASON_KEY);

    setRole("resident");
    window.sessionStorage.removeItem(RESIDENT_REJECTED_KEY);
    if (rejectionReason?.trim()) {
      setError("Your registration was rejected by admin. Please review the reason and sign up again.");
    }
    navigate("/signup-resident?reapply=1", { replace: true });
  }, [navigate]);

  // Redirect if already logged in
  if (isAuthenticated && user) {
    const dest = user.role === "resident" ? "/" : "/responder";
    return <Navigate to={dest} replace />;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    try {
      await login(email, password, role);
      navigate(role === "resident" ? "/" : "/responder", { replace: true });
    } catch (err) {
      setError((err as Error).message || "Unable to sign in.");
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6 bg-background animate-fade-in">
      <div className="w-full max-w-sm space-y-6">
        {/* Logo / Header */}
        <div className="text-center space-y-2">
          <div className="inline-flex items-center gap-2 bg-emergency-light text-emergency rounded-full px-3 py-1 text-xs font-semibold">
            <AlertTriangle size={14} />
            Emergency Response
          </div>
          <h1 className="text-2xl font-black text-foreground">Sign In</h1>
          <p className="text-sm text-muted-foreground">Access the emergency response system</p>
        </div>

        {/* Role Toggle */}
        <div className="relative bg-secondary rounded-2xl p-1 animate-slide-up">
          <div
            className={cn(
              "absolute top-1 left-1 h-[calc(100%-0.5rem)] w-[calc(50%-0.5rem)] rounded-xl bg-card transition-all duration-300 ease-out",
              role === "responder" ? "translate-x-[100%]" : "translate-x-0"
            )}
          />
          <div className="relative flex gap-1">
            {([
              { id: "resident" as UserRole, icon: Users, label: "Resident" },
              { id: "responder" as UserRole, icon: ShieldCheck, label: "Responder" },
            ]).map((r) => {
              const Icon = r.icon;
              const active = role === r.id;
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setRole(r.id)}
                  aria-pressed={active}
                  className={cn(
                    "flex-1 relative z-10 flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold toggle-fade",
                    active
                      ? "text-foreground"
                      : "text-muted-foreground"
                  )}
                >
                  <Icon size={18} />
                  {r.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-3 animate-slide-up">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email address"
            className="w-full bg-secondary rounded-xl px-4 py-3.5 text-sm placeholder:text-muted-foreground outline-none focus:ring-2 focus:ring-emergency/30"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            className="w-full bg-secondary rounded-xl px-4 py-3.5 text-sm placeholder:text-muted-foreground outline-none focus:ring-2 focus:ring-emergency/30"
          />
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-emergency text-emergency-foreground rounded-2xl py-4 font-bold text-base flex items-center justify-center gap-2 active:scale-[0.98] transition-transform"
          >
            {loading ? (
              <Loader2 size={20} className="animate-spin" />
            ) : (
              <>Sign In as {role === "resident" ? "Resident" : "Responder"}</>
            )}
          </button>
          {error && <p className="text-sm text-destructive text-center">{error}</p>}
        </form>

        {role === "resident" ? (
          <p className="text-xs text-center text-muted-foreground">
            New resident?{" "}
            <Link to="/signup-resident" className="text-emergency font-semibold">
              Create verified account
            </Link>
          </p>
        ) : (
          <p className="text-[11px] text-center text-muted-foreground">
            Use responder credentials created by admin.
          </p>
        )}
      </div>
    </div>
  );
}

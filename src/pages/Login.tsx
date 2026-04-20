import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import {
  RESIDENT_REJECTED_KEY,
  RESIDENT_REJECTION_REASON_KEY,
  useAuth,
} from "@/contexts/AuthContext";
import { Loader2 } from "lucide-react";

export default function Login() {
  const { login, loading, isAuthenticated, user } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const rejected = window.sessionStorage.getItem(RESIDENT_REJECTED_KEY);
    if (!rejected) return;
    const rejectionReason = window.sessionStorage.getItem(RESIDENT_REJECTION_REASON_KEY);

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
      const authUser = await login(email, password);
      navigate(authUser.role === "resident" ? "/" : "/responder", { replace: true });
    } catch (err) {
      setError((err as Error).message || "Unable to sign in.");
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6 animate-fade-in bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.16),transparent_45%),radial-gradient(circle_at_top_right,rgba(245,158,11,0.12),transparent_42%)]">
      <div className="w-full max-w-sm space-y-5">
        {/* Logo / Header */}
        <div className="rounded-2xl border border-white/45 bg-white/45 p-5 text-center space-y-2 shadow-[0_28px_70px_-44px_rgba(15,23,42,0.55)] backdrop-blur-xl">
          <img
            src="/assets/banisilan.png"
            alt="Municipality of Banisilan Seal"
            className="mx-auto h-20 w-20 object-contain"
          />
          <div className="inline-flex items-center rounded-full border border-orange-300 bg-orange-100 px-3 py-1 text-xs font-semibold text-orange-600">
            MDRRMO Banisilan
          </div>
          <h1 className="text-4xl font-black leading-tight text-orange-600">Sign In</h1>
          <p className="text-sm text-muted-foreground">Access the emergency response system</p>
        </div>

        {/* Form */}
        <div className="rounded-2xl border border-white/45 bg-white/45 p-5 shadow-[0_28px_70px_-44px_rgba(15,23,42,0.55)] backdrop-blur-xl">
          <form onSubmit={handleSubmit} className="space-y-3 animate-slide-up">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email address"
              className="w-full rounded-xl border border-white/55 bg-white/55 px-4 py-3.5 text-sm placeholder:text-muted-foreground outline-none backdrop-blur-md focus:ring-2 focus:ring-warning/35"
            />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              className="w-full rounded-xl border border-white/55 bg-white/55 px-4 py-3.5 text-sm placeholder:text-muted-foreground outline-none backdrop-blur-md focus:ring-2 focus:ring-warning/35"
            />
            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-2xl bg-orange-600 py-4 text-base font-bold text-white flex items-center justify-center gap-2 active:scale-[0.98] transition-transform disabled:opacity-70"
            >
              {loading ? (
                <Loader2 size={20} className="animate-spin" />
              ) : (
                <>Sign In</>
              )}
            </button>
            {error && <p className="text-sm text-destructive text-center">{error}</p>}
            <Link
              to="/forgot-password"
              className="block w-full text-center text-xs text-orange-600 hover:text-orange-700 transition-colors"
            >
              Forgot password?
            </Link>
          </form>

          <p className="mt-5 text-xs text-center text-muted-foreground">
            New resident?{" "}
            <Link to="/signup-resident" className="text-orange-600 font-semibold">
              Create verified account
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}

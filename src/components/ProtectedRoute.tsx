import { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAuth, UserRole } from "@/contexts/AuthContext";
import { Loader2 } from "lucide-react";

export function ProtectedRoute({
  children,
  allowedRoles,
}: {
  children: ReactNode;
  allowedRoles?: UserRole[];
}) {
  const { user, loading, isAuthenticated } = useAuth();

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="animate-spin text-emergency" size={32} />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  if (allowedRoles && user && !allowedRoles.includes(user.role)) {
    const redirect = user.role === "resident" ? "/" : "/responder";
    return <Navigate to={redirect} replace />;
  }

  return <>{children}</>;
}

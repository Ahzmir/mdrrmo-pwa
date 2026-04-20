import { useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes, Navigate, useLocation } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { BottomNav } from "@/components/BottomNav";
import { ResponderNav } from "@/components/ResponderNav";
import { OfflineIndicator } from "@/components/OfflineIndicator";
import Login from "@/pages/Login";
import ResidentSignUp from "@/pages/ResidentSignUp";
import Home from "@/pages/Home";
import Settings from "@/pages/Settings";
import ReportForm from "@/pages/ReportForm";
import MyReports from "@/pages/MyReports";
import ResponderDashboard from "@/pages/ResponderDashboard";
import ResponderHistory from "@/pages/ResponderHistory";
import ResponderStatus from "@/pages/ResponderStatus";
import ResponderIncidentDetails from "@/pages/ResponderIncidentDetails";
import ResponderSettings from "@/pages/ResponderSettings";
import ForgotPassword from "@/pages/ForgotPassword";
import NotFound from "@/pages/NotFound";
import { syncOfflineQueuedReportsForResident } from "@/lib/offlineReportSync";

const queryClient = new QueryClient();
const OFFLINE_REPORT_SYNC_INTERVAL_MS = 15000;

function AppRoutes() {
  const { user } = useAuth();
  const { pathname } = useLocation();
  const isResident = user?.role === "resident";
  const isResponder = user?.role === "responder";
  const showResponderNav = isResponder && !pathname.startsWith("/responder/incidents/");

  useEffect(() => {
    if (!isResident || !user) {
      return;
    }

    let disposed = false;

    const runSync = async () => {
      if (disposed || !navigator.onLine) {
        return;
      }

      await syncOfflineQueuedReportsForResident({
        id: user.id,
        name: user.name,
        email: user.email,
      });
    };

    const onOnline = () => {
      void runSync();
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void runSync();
      }
    };

    window.addEventListener("online", onOnline);
    window.addEventListener("focus", onOnline);
    document.addEventListener("visibilitychange", onVisible);

    void runSync();
    const intervalId = window.setInterval(() => {
      void runSync();
    }, OFFLINE_REPORT_SYNC_INTERVAL_MS);

    return () => {
      disposed = true;
      window.removeEventListener("online", onOnline);
      window.removeEventListener("focus", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(intervalId);
    };
  }, [isResident, user]);

  return (
    <div className="min-h-screen bg-background">
      <OfflineIndicator />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/signup-resident" element={<ResidentSignUp />} />

        {/* Resident routes */}
        <Route
          path="/"
          element={
            <ProtectedRoute allowedRoles={["resident"]}>
              <Home />
            </ProtectedRoute>
          }
        />
        <Route
          path="/report"
          element={
            <ProtectedRoute allowedRoles={["resident"]}>
              <ReportForm />
            </ProtectedRoute>
          }
        />
        <Route
          path="/my-reports"
          element={
            <ProtectedRoute allowedRoles={["resident"]}>
              <MyReports />
            </ProtectedRoute>
          }
        />
        <Route
          path="/settings"
          element={
            <ProtectedRoute allowedRoles={["resident"]}>
              <Settings />
            </ProtectedRoute>
          }
        />

        {/* Responder routes */}
        <Route
          path="/responder"
          element={
            <ProtectedRoute allowedRoles={["responder"]}>
              <ResponderDashboard />
            </ProtectedRoute>
          }
        />
        <Route
          path="/responder/history"
          element={
            <ProtectedRoute allowedRoles={["responder"]}>
              <ResponderHistory />
            </ProtectedRoute>
          }
        />
        <Route
          path="/responder/status"
          element={
            <ProtectedRoute allowedRoles={["responder"]}>
              <ResponderStatus />
            </ProtectedRoute>
          }
        />
        <Route
          path="/responder/settings"
          element={
            <ProtectedRoute allowedRoles={["responder"]}>
              <ResponderSettings />
            </ProtectedRoute>
          }
        />
        <Route
          path="/responder/incidents/:incidentId"
          element={
            <ProtectedRoute allowedRoles={["responder"]}>
              <ResponderIncidentDetails />
            </ProtectedRoute>
          }
        />

        <Route path="*" element={<NotFound />} />
      </Routes>
      {isResident && <BottomNav />}
      {showResponderNav && <ResponderNav />}
    </div>
  );
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <AuthProvider>
        <BrowserRouter
          future={{
            v7_startTransition: true,
            v7_relativeSplatPath: true,
          }}
        >
          <AppRoutes />
        </BrowserRouter>
      </AuthProvider>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;

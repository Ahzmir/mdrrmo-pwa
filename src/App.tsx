import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes, Navigate } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { BottomNav } from "@/components/BottomNav";
import { OfflineIndicator } from "@/components/OfflineIndicator";
import Login from "@/pages/Login";
import ResidentSignUp from "@/pages/ResidentSignUp";
import Home from "@/pages/Home";
import ReportForm from "@/pages/ReportForm";
import MyReports from "@/pages/MyReports";
import ResponderDashboard from "@/pages/ResponderDashboard";
import ResponderIncidentDetails from "@/pages/ResponderIncidentDetails";
import NotFound from "@/pages/NotFound";

const queryClient = new QueryClient();

function AppRoutes() {
  const { user } = useAuth();
  const isResident = user?.role === "resident";

  return (
    <div className="min-h-screen bg-background">
      <OfflineIndicator />
      <Routes>
        <Route path="/login" element={<Login />} />
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
    </div>
  );
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <AuthProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </AuthProvider>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;

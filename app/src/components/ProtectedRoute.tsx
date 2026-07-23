import { Navigate } from "react-router-dom";
import { useAuthStore } from "@/store/auth.store";

/**
 * Gates a route on authentication. When `allowGuest` is set, a user in guest
 * mode (chose "continue as guest") is also let through — used for the on-device
 * tools that need no backend. Everyone else is bounced to /login.
 */
export default function ProtectedRoute({
  children,
  allowGuest = false,
}: {
  children: React.ReactNode;
  allowGuest?: boolean;
}) {
  const { isAuthenticated, isGuest } = useAuthStore();
  if (isAuthenticated()) return <>{children}</>;
  if (allowGuest && isGuest()) return <>{children}</>;
  return <Navigate to="/login" replace />;
}

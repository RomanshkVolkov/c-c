import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import Login from "@/pages/Login";
import ReportsRedirect from "@/components/ReportsRedirect";
import ErrorBoundary from "@/components/ErrorBoundary";
import Dashboard from "@/pages/Dashboard";
import ServerManage from "@/pages/ServerManage";
import ServerStats from "@/pages/ServerStats";
import StackSecrets from "@/pages/StackSecrets";
import ImageTool from "@/pages/ImageTool";
import RequestClient from "@/pages/RequestClient";
import CryptoTools from "@/pages/CryptoTools";
import Users from "@/pages/Users";
import OrganizationSettings from "@/pages/OrganizationSettings";
import Invitations from "@/pages/Invitations";
import Diagnostics from "@/pages/Diagnostics";
import Tasks from "@/pages/Tasks";
import Notes from "@/pages/Notes";
import ProtectedRoute from "@/components/ProtectedRoute";
import DevTools from "@/pages/DevTools";
import Channels from "@/pages/Channels";
import DirectMessages from "@/pages/DirectMessages";
import AppLayout from "@/components/AppLayout";
import { ConfirmProvider } from "@/components/ConfirmDialog";
import { PromptProvider } from "@/components/PromptDialog";
import { useAuthStore } from "@/store/auth.store";

// Sends unknown paths to the right landing: the board for signed-in users, the
// on-device tools for returning guests, otherwise the login screen.
function RootRedirect() {
  const { isAuthenticated, isGuest } = useAuthStore();
  if (isAuthenticated()) return <Navigate to="/dashboard" replace />;
  if (isGuest()) return <Navigate to="/image-tool" replace />;
  return <Navigate to="/login" replace />;
}

export default function App() {
  return (
    // Outermost on purpose: a crash anywhere below leaves the window showing
    // the app's own background and nothing else, which is impossible to
    // diagnose from a screenshot — see ErrorBoundary.
    <ErrorBoundary>
    <ConfirmProvider>
      <PromptProvider>
      <BrowserRouter>
        <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          element={
            <ProtectedRoute>
              <AppLayout />
            </ProtectedRoute>
          }
        >
          <Route path="/dashboard" element={<Dashboard />} />
          {/* The reports window is gone — its work lives on the board. The
              route stays as a redirect because notifications already sent are
              stored with /reports links, and a report's id *is* the item's id,
              so the translation is exact. See ReportsRedirect. */}
          <Route path="/reports" element={<ReportsRedirect />} />
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/chat" element={<Channels />} />
          <Route path="/dm" element={<DirectMessages />} />
          <Route path="/notes" element={<Notes />} />
          <Route path="/notes/:id" element={<Notes />} />
          <Route path="/servers/:id" element={<ServerManage />} />
          <Route path="/servers/:id/stats" element={<ServerStats />} />
          <Route path="/servers/:id/secrets" element={<StackSecrets />} />
          <Route path="/organization" element={<OrganizationSettings />} />
          <Route path="/invitations" element={<Invitations />} />
          <Route path="/diagnostics" element={<Diagnostics />} />
          <Route path="/users" element={<Users />} />
        </Route>
        {/* On-device tools — reachable as a guest (no backend/sign-in).
            Requests is the exception and keeps its own gate inside: it talks to
            whatever host you point it at, but it lives behind the account like
            the rest of the product. */}
        <Route
          element={
            <ProtectedRoute allowGuest>
              <AppLayout />
            </ProtectedRoute>
          }
        >
          <Route path="/devtools" element={<DevTools />}>
            <Route index element={<Navigate to="image" replace />} />
            <Route path="image" element={<ImageTool />} />
            <Route path="tokens" element={<CryptoTools />} />
            <Route
              path="requests"
              element={
                <ProtectedRoute>
                  <RequestClient />
                </ProtectedRoute>
              }
            />
          </Route>
          {/* The old addresses still work: they were in menus, bookmarks and in
              the guest flow, and a dead link is a worse greeting than a hop. */}
          <Route path="/image-tool" element={<Navigate to="/devtools/image" replace />} />
          <Route path="/crypto" element={<Navigate to="/devtools/tokens" replace />} />
          <Route path="/requests" element={<Navigate to="/devtools/requests" replace />} />
        </Route>
        <Route path="*" element={<RootRedirect />} />
        </Routes>
      </BrowserRouter>
      </PromptProvider>
    </ConfirmProvider>
    </ErrorBoundary>
  );
}

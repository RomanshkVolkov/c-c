import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { isWebBuild } from "@/lib/platform";
import Login from "@/pages/Login";
import ReportsRedirect from "@/components/ReportsRedirect";
import ErrorBoundary from "@/components/ErrorBoundary";
import Overview from "@/pages/Overview";
import Profile from "@/pages/Profile";
import Users from "@/pages/Users";
import OrganizationSettings from "@/pages/OrganizationSettings";
import Invitations from "@/pages/Invitations";
import Diagnostics from "@/pages/Diagnostics";
import Activity from "@/pages/Activity";
import Tasks from "@/pages/Tasks";
import DocIndexPage from "@/pages/DocIndexPage";
import Notes from "@/pages/Notes";
import ProtectedRoute from "@/components/ProtectedRoute";
import MyWork from "@/pages/MyWork";
import Channels from "@/pages/Channels";
import DirectMessages from "@/pages/DirectMessages";
import AppLayout from "@/components/AppLayout";
import { ConfirmProvider } from "@/components/ConfirmDialog";
import { PromptProvider } from "@/components/PromptDialog";
import { useAuthStore } from "@/store/auth.store";

// Lo que sólo tiene sentido en el escritorio —los servidores, sus secrets y
// provisioning, las herramientas de desarrollo— se carga aparte, y en la
// versión web (`isWebBuild`) sus rutas ni existen. Así el bundle web no lleva
// terminales, Ansible ni el cliente HTTP local, y en el escritorio cada una se
// carga del disco la primera vez que se abre.
//
// La pregunta va aquí, con `import.meta.env` en el sitio y no con `isWebBuild`
// importado: sólo así Rollup la resuelve al compilar y no emite esos trozos.
// Con el `import()` en el código, aunque la ruta no exista, el trozo se publica
// igual en /app/assets y cualquiera lo puede descargar.
const WEB = import.meta.env.VITE_TARGET === "web";
const NotOnWeb = () => null;
const Dashboard = WEB ? NotOnWeb : lazy(() => import("@/pages/Dashboard"));
const ServerLayout = WEB ? NotOnWeb : lazy(() => import("@/pages/servers/ServerLayout"));
const ServerOverview = WEB ? NotOnWeb : lazy(() => import("@/pages/servers/ServerOverview"));
const ServerServices = WEB ? NotOnWeb : lazy(() => import("@/pages/servers/ServerServices"));
const ServerNodes = WEB ? NotOnWeb : lazy(() => import("@/pages/servers/ServerNodes"));
const ServerProvision = WEB ? NotOnWeb : lazy(() => import("@/pages/servers/ServerProvision"));
const ServerStats = WEB ? NotOnWeb : lazy(() => import("@/pages/ServerStats"));
const StackSecrets = WEB ? NotOnWeb : lazy(() => import("@/pages/StackSecrets"));
const ImageTool = WEB ? NotOnWeb : lazy(() => import("@/pages/ImageTool"));
const RequestClient = WEB ? NotOnWeb : lazy(() => import("@/pages/RequestClient"));
const CryptoTools = WEB ? NotOnWeb : lazy(() => import("@/pages/CryptoTools"));
const VoiceLab = WEB ? NotOnWeb : lazy(() => import("@/pages/VoiceLab"));
const DevTools = WEB ? NotOnWeb : lazy(() => import("@/pages/DevTools"));

// Sends unknown paths to the right landing: the overview for signed-in users,
// the on-device tools for returning guests, otherwise the login screen.
//
// El resumen y no la lista de servidores: abrir la app en la infraestructura
// hacía que lo primero que vieras fuera lo que casi nunca cambia, y lo que sí
// —reportes, tareas, quién te habló— quedara a un clic de distancia cada día.
function RootRedirect() {
  const { isAuthenticated, isGuest } = useAuthStore();
  if (isAuthenticated()) return <Navigate to="/overview" replace />;
  // En la versión web no hay herramientas de invitado: ir a ellas daría la
  // vuelta por aquí para siempre.
  if (isGuest() && !isWebBuild) return <Navigate to="/image-tool" replace />;
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
      {/* `/app` en la versión web, la raíz en el escritorio (ver vite.config). */}
      <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, "")}>
        <Suspense fallback={null}>
        <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          element={
            <ProtectedRoute>
              <AppLayout />
            </ProtectedRoute>
          }
        >
          <Route path="/overview" element={<Overview />} />
          {!isWebBuild && <Route path="/dashboard" element={<Dashboard />} />}
          {/* The reports window is gone — its work lives on the board. The
              route stays as a redirect because notifications already sent are
              stored with /reports links, and a report's id *is* the item's id,
              so the translation is exact. See ReportsRedirect. */}
          <Route path="/reports" element={<ReportsRedirect />} />
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/docs" element={<DocIndexPage />} />
          <Route path="/my-work" element={<MyWork />} />
          <Route path="/chat" element={<Channels />} />
          <Route path="/dm" element={<DirectMessages />} />
          <Route path="/notes" element={<Notes />} />
          <Route path="/notes/:id" element={<Notes />} />
          {!isWebBuild && (
          <Route path="/servers/:id" element={<ServerLayout />}>
            <Route index element={<ServerOverview />} />
            <Route path="services" element={<ServerServices />} />
            <Route path="nodes" element={<ServerNodes />} />
            <Route path="stats" element={<ServerStats />} />
            <Route path="secrets" element={<StackSecrets />} />
            <Route path="provision" element={<ServerProvision />} />
          </Route>
          )}
          <Route path="/organization" element={<OrganizationSettings />} />
          <Route path="/invitations" element={<Invitations />} />
          <Route path="/activity" element={<Activity />} />
          <Route path="/diagnostics" element={<Diagnostics />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/users" element={<Users />} />
        </Route>
        {/* On-device tools — reachable as a guest (no backend/sign-in).
            Requests is the exception and keeps its own gate inside: it talks to
            whatever host you point it at, but it lives behind the account like
            the rest of the product. */}
        {!isWebBuild && (
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
            <Route path="voice" element={<VoiceLab />} />
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
        )}
        <Route path="*" element={<RootRedirect />} />
        </Routes>
        </Suspense>
      </BrowserRouter>
      </PromptProvider>
    </ConfirmProvider>
    </ErrorBoundary>
  );
}

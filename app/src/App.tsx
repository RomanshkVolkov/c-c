import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import Login from "@/pages/Login";
import Dashboard from "@/pages/Dashboard";
import ServerManage from "@/pages/ServerManage";
import StackSecrets from "@/pages/StackSecrets";
import ImageTool from "@/pages/ImageTool";
import RequestClient from "@/pages/RequestClient";
import CryptoTools from "@/pages/CryptoTools";
import ProtectedRoute from "@/components/ProtectedRoute";
import AppLayout from "@/components/AppLayout";

export default function App() {
  return (
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
          <Route path="/servers/:id" element={<ServerManage />} />
          <Route path="/servers/:id/secrets" element={<StackSecrets />} />
          <Route path="/image-tool" element={<ImageTool />} />
          <Route path="/requests" element={<RequestClient />} />
          <Route path="/crypto" element={<CryptoTools />} />
        </Route>
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

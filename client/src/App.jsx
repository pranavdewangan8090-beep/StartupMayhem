import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './lib/AuthContext.jsx';
import Login from './pages/Login.jsx';
import PlayerApp from './pages/player/PlayerApp.jsx';
import AdminApp from './pages/admin/AdminApp.jsx';
import SuperAdminApp from './pages/super/SuperAdminApp.jsx';

function Loading() {
  return <div className="empty-state">Loading…</div>;
}

export default function App() {
  const { user } = useAuth();

  if (user === undefined) return <Loading />;

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login />} />
      <Route
        path="/*"
        element={
          !user ? (
            <Navigate to="/login" replace />
          ) : user.role === 'player' ? (
            <PlayerApp />
          ) : user.role === 'admin' ? (
            <AdminApp />
          ) : (
            <SuperAdminApp />
          )
        }
      />
    </Routes>
  );
}

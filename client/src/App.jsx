import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './lib/AuthContext.jsx';
import Login from './pages/Login.jsx';
import PlayerApp from './pages/player/PlayerApp.jsx';
import AdminApp from './pages/admin/AdminApp.jsx';
import SuperAdminApp from './pages/super/SuperAdminApp.jsx';

const Landing = lazy(() => import('./pages/Landing.jsx'));

function Loading() {
  return <div className="empty-state">Loading…</div>;
}

export default function App() {
  const { user } = useAuth();

  if (user === undefined) return <Loading />;

  return (
    <Routes>
      <Route
        path="/"
        element={
          user ? (
            <Navigate to="/app" replace />
          ) : (
            <Suspense fallback={<Loading />}>
              <Landing />
            </Suspense>
          )
        }
      />
      <Route path="/login" element={user ? <Navigate to="/app" replace /> : <Login />} />
      <Route
        path="/app/*"
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
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

import { lazy, Suspense } from 'react'
import { Route, Routes } from 'react-router-dom'
import { AuthProvider } from './auth/AuthContext'
import { PrivateRoute } from './auth/PrivateRoute'
import { ErrorBoundary } from './app/ErrorBoundary'
import { HomePage } from './pages/HomePage'
import { LoginPage } from './pages/LoginPage'
import { RegisterPage } from './pages/RegisterPage'
import { EstadoPage } from './pages/EstadoPage'
import { NotFoundPage } from './pages/NotFoundPage'
import { NoPermissionPage } from './pages/NoPermissionPage'
import { FilesListPage } from './pages/FilesListPage'
import { RefinePage } from './pages/RefinePage'

// Code splitting: las paginas del piso no entran al bundle inicial de /login (CP6).
const RefinersPage = lazy(() => import('./pages/RefinersPage').then((m) => ({ default: m.RefinersPage })))

function PageFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-300">
      <p aria-live="polite">Cargando…</p>
    </div>
  )
}

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/sin-permiso" element={<NoPermissionPage />} />

          <Route path="/" element={<PrivateRoute><HomePage /></PrivateRoute>} />
          <Route path="/estado" element={<PrivateRoute><EstadoPage /></PrivateRoute>} />

          {/* CP2 */}
          <Route path="/files" element={<PrivateRoute requires="files:read"><FilesListPage /></PrivateRoute>} />
          <Route path="/files/:id/refine" element={<PrivateRoute requires="files:refine"><RefinePage /></PrivateRoute>} />

          <Route
            path="/refiners"
            element={
              <PrivateRoute requires="refiners:read">
                <Suspense fallback={<PageFallback />}>
                  <RefinersPage />
                </Suspense>
              </PrivateRoute>
            }
          />

          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </AuthProvider>
    </ErrorBoundary>
  )
}

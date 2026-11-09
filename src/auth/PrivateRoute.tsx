import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from './AuthContext'

interface PrivateRouteProps {
  children: ReactNode
  /**
   * Permiso requerido para esta ruta. Si no se pasa, basta con estar
   * autenticado. Si se pasa y el usuario no lo tiene, se muestra la pagina
   * "sin permiso" (403 UI), no redirect al login.
   */
  requires?: string
}

export function PrivateRoute({ children, requires }: PrivateRouteProps) {
  const { ready, user, hasPermission } = useAuth()
  const location = useLocation()

  // Mientras verificamos la sesion (restore con refresh token), pintar un
  // spinner. CP1 exige NO mostrar el login un instante antes de restaurar.
  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-300">
        <p aria-live="polite">Conectando con Lumon…</p>
      </div>
    )
  }

  if (!user) {
    // Guardar a donde queria ir (path + query) para volver tras el login.
    const next = location.pathname + location.search
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />
  }

  if (requires && !hasPermission(requires)) {
    return <Navigate to="/sin-permiso" replace />
  }

  return <>{children}</>
}

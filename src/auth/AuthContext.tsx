import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { apiFetch } from '../lib/apiClient'
import {
  clearSession,
  getStoredRefreshToken,
  saveTokens,
} from '../lib/session'
import { onTabMessage } from '../lib/tabChannel'
import type {
  AuthResponse,
  MeResponse,
  Team,
  User,
} from '../lib/types'

interface AuthState {
  /** false mientras intentamos restaurar la sesion (anti-flash en PrivateRoute). */
  ready: boolean
  user: User | null
  team: Team | null
  role: { code: string; name: string } | null
  permissions: string[]
  clearance: { granted: boolean; grantedAt: string | null }
}

interface AuthActions {
  login: (email: string, password: string) => Promise<void>
  register: (teamName: string, email: string, password: string) => Promise<void>
  logout: () => Promise<void>
  /** Refresca /auth/me (por ejemplo tras un cambio de permisos). */
  refreshMe: () => Promise<void>
  /** true si el usuario tiene el permiso dado (ver docs del CP1). */
  hasPermission: (perm: string) => boolean
}

type AuthContextValue = AuthState & AuthActions

const AuthContext = createContext<AuthContextValue | null>(null)

const emptyState: AuthState = {
  ready: false,
  user: null,
  team: null,
  role: null,
  permissions: [],
  clearance: { granted: false, grantedAt: null },
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(emptyState)

  const applyMe = useCallback((me: MeResponse) => {
    setState({
      ready: true,
      user: { id: me.id, email: me.email, displayName: me.displayName },
      team: me.team,
      role: me.role,
      permissions: me.permissions,
      clearance: me.clearance,
    })
  }, [])

  const refreshMe = useCallback(async () => {
    const me = await apiFetch<MeResponse>('/auth/me')
    applyMe(me)
  }, [applyMe])

  const resetToAnon = useCallback(() => {
    setState({ ...emptyState, ready: true })
  }, [])

  // Al montar, intentar restaurar la sesion con el refresh token guardado.
  // Si no hay refresh token, ya estamos en estado anon (ready = true).
  // Si hay pero falla, limpiar y quedar en anon.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (!getStoredRefreshToken()) {
        if (!cancelled) resetToAnon()
        return
      }
      try {
        // apiFetch detecta que no hay accessToken en memoria y hace refresh
        // automatico con el refresh token guardado antes de llamar /auth/me.
        const me = await apiFetch<MeResponse>('/auth/me')
        if (!cancelled) applyMe(me)
      } catch {
        if (!cancelled) {
          clearSession('restore_failed')
          resetToAnon()
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [applyMe, resetToAnon])

  // Si otra pestana cerro sesion (logout en otra pestana, o session.revoked),
  // esta tambien pasa a anon. El CP1 exige propagacion < 2s entre pestanas.
  useEffect(() => {
    const unsubscribe = onTabMessage((msg) => {
      if (msg.type === 'session.cleared') {
        resetToAnon()
      }
    })
    return unsubscribe
  }, [resetToAnon])

  const login = useCallback(
    async (email: string, password: string) => {
      const auth = await apiFetch<AuthResponse>('/auth/login', {
        auth: false,
        method: 'POST',
        body: { email, password },
      })
      saveTokens(auth)
      // Login no trae team/role/permissions: lo pedimos aparte.
      const me = await apiFetch<MeResponse>('/auth/me')
      applyMe(me)
    },
    [applyMe],
  )

  const register = useCallback(
    async (teamName: string, email: string, password: string) => {
      const auth = await apiFetch<AuthResponse>('/auth/register', {
        auth: false,
        method: 'POST',
        body: { teamName, email, password },
      })
      saveTokens(auth)
      // /auth/register SI devuelve team, pero igual pedimos /me para tener
      // permissions + role + clearance consistentes.
      const me = await apiFetch<MeResponse>('/auth/me')
      applyMe(me)
    },
    [applyMe],
  )

  const logout = useCallback(async () => {
    const refreshToken = getStoredRefreshToken()
    // Vaciar estado + storage YA (no esperar al backend). El broadcast en
    // clearSession avisa a las otras pestanas.
    clearSession('logout')
    resetToAnon()
    if (refreshToken) {
      try {
        await apiFetch<void>('/auth/logout', {
          auth: false,
          method: 'POST',
          body: { refreshToken },
        })
      } catch {
        // Si falla, da igual: la sesion local ya esta limpia.
      }
    }
  }, [resetToAnon])

  const hasPermission = useCallback(
    (perm: string) => state.permissions.includes(perm),
    [state.permissions],
  )

  const value = useMemo<AuthContextValue>(
    () => ({
      ...state,
      login,
      register,
      logout,
      refreshMe,
      hasPermission,
    }),
    [state, login, register, logout, refreshMe, hasPermission],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth debe usarse dentro de <AuthProvider>')
  return ctx
}

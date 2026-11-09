import type { TokenPair } from './types'
import { broadcastTab, onTabMessage } from './tabChannel'

// Guarda la sesion siguiendo el contrato:
//   - accessToken: SOLO EN MEMORIA, nunca localStorage/sessionStorage/cookies.
//     Se pierde al recargar y se restaura con el refreshToken en App.
//   - refreshToken: un solo uso. Se guarda en localStorage para sobrevivir a
//     un F5 y para que todas las pestanas del mismo origen vean el mismo.
//     Cada /auth/refresh devuelve uno nuevo y el anterior deja de servir.

const REFRESH_TOKEN_KEY = 'lumon.refresh'

let accessToken: string | null = null
let accessTokenExpiresAt = 0

export function getAccessToken(): string | null {
  return accessToken
}

export function isAccessTokenExpired(): boolean {
  // 5s de margen de seguridad para no quedarse con el token vencido
  // justo entre el check y la llegada de la respuesta.
  return !accessToken || Date.now() >= accessTokenExpiresAt - 5_000
}

export function getStoredRefreshToken(): string | null {
  try {
    return localStorage.getItem(REFRESH_TOKEN_KEY)
  } catch {
    return null
  }
}

export function saveTokens(tokens: TokenPair): void {
  accessToken = tokens.accessToken
  accessTokenExpiresAt = Date.now() + tokens.expiresIn * 1000
  try {
    localStorage.setItem(REFRESH_TOKEN_KEY, tokens.refreshToken)
    // Avisar a otras pestanas por si estaban sin sesion.
    broadcastTab({ type: 'session.saved' })
  } catch {
    // Ignorar si localStorage no esta disponible (ventana incognito, etc.).
  }
}

export function clearSession(reason: string = 'logout'): void {
  accessToken = null
  accessTokenExpiresAt = 0
  try {
    localStorage.removeItem(REFRESH_TOKEN_KEY)
  } catch {
    // ignorar
  }
  broadcastTab({ type: 'session.cleared', reason })
}

// Escucha en TODAS las pestanas: si otra pestana borro la sesion, esta tambien
// tiene que limpiarse. Se llama una vez al cargar el modulo.
onTabMessage((msg) => {
  if (msg.type === 'session.cleared') {
    // Otra pestana cerro sesion. Limpiar SOLO la memoria (el storage ya lo
    // borro la otra pestana, y no queremos re-disparar el broadcast).
    accessToken = null
    accessTokenExpiresAt = 0
  }
})

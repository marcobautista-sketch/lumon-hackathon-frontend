// Guarda la sesión (tokens) siguiendo exactamente lo que pide el contrato:
//
//   - accessToken: "Solo en memoria" -> nunca a localStorage. Se pierde al
//     recargar la pagina a proposito (por eso restauramos la sesion con el
//     refreshToken al montar la app, ver RestoreSession en App.tsx).
//   - refreshToken: "de un solo uso" -> cada vez que se usa, el backend lo
//     invalida y entrega uno nuevo. Hay que reemplazarlo YA en cuanto llega
//     la respuesta, o el proximo refresh falla y el backend revoca TODA la
//     sesion (todas las pestañas). Por eso vive en localStorage: sobrevive
//     a un F5 y, en el mismo origen, se comparte entre pestañas.
import type { TokenPair } from './types'

const REFRESH_TOKEN_KEY = 'lumon.refreshToken'

let accessToken: string | null = null
let accessTokenExpiresAt = 0 // Date.now() + expiresIn*1000

export function getAccessToken(): string | null {
  return accessToken
}

export function isAccessTokenExpired(): boolean {
  // 5s de margen para que no expire "en el camino" de una peticion.
  return !accessToken || Date.now() >= accessTokenExpiresAt - 5_000
}

export function getStoredRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_TOKEN_KEY)
}

export function saveTokens(tokens: TokenPair): void {
  accessToken = tokens.accessToken
  accessTokenExpiresAt = Date.now() + tokens.expiresIn * 1000
  localStorage.setItem(REFRESH_TOKEN_KEY, tokens.refreshToken)
}

export function clearSession(): void {
  accessToken = null
  accessTokenExpiresAt = 0
  localStorage.removeItem(REFRESH_TOKEN_KEY)
}

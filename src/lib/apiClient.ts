import { ApiError, type ApiErrorBody, type TokenPair } from './types'
import {
  getAccessToken,
  getStoredRefreshToken,
  isAccessTokenExpired,
  saveTokens,
  clearSession,
} from './session'

const API_BASE = import.meta.env.VITE_API_BASE_URL as string

// SHA del commit, inyectado por Vite en build time via la env var
// VITE_LUMON_BUILD_SHA (ver vite.config.ts). El backend exige la cabecera
// X-Lumon-Build en cada request desde produccion.
const BUILD_SHA = (import.meta.env.VITE_LUMON_BUILD_SHA as string | undefined) ?? 'dev'

interface ApiFetchOptions extends Omit<RequestInit, 'body'> {
  body?: unknown
  /** Pasar false solo para endpoints publicos: register, login, refresh. */
  auth?: boolean
  /** Si se pasa, se concatena a los headers. Content-Type lo decide apiFetch. */
  extraHeaders?: Record<string, string>
}

// --- Refresh coordinado entre requests Y entre pestañas --------------------
// Regla del enunciado: "con dos o mas pestanas abiertas, el vencimiento del
// token nunca provoca REFRESH_REUSED". Dos niveles de coordinacion:
//
//   1. Dentro de una pestana: todas las requests que detectan TOKEN_EXPIRED
//      a la vez comparten una sola promesa (refreshInFlight).
//   2. Entre pestañas del mismo origen: Web Locks API (navigator.locks).
//      Solo una pestana a la vez entra a la seccion critica; las demas
//      esperan. Al entrar, cada pestana RELEE el refresh token actual de
//      localStorage, por si otra pestana ya lo roto mientras esperaba.
let refreshInFlight: Promise<void> | null = null

async function refreshAccessToken(): Promise<void> {
  if (refreshInFlight) return refreshInFlight

  refreshInFlight = (async () => {
    // Si el navegador no tiene Web Locks (no deberia pasar en Chrome/Firefox
    // modernos, pero fallback por si acaso), hacemos el refresh igual sin
    // coordinacion entre pestanas.
    const runCriticalSection = async () => {
      // RELEER del storage: otra pestana pudo haber hecho el refresh mientras
      // esta esperaba el lock. Si el token en memoria ya es nuevo, no refresh.
      const storedRefreshToken = getStoredRefreshToken()
      if (!storedRefreshToken) {
        throw new ApiError(401, emptyError('NO_REFRESH_TOKEN'))
      }
      if (!isAccessTokenExpired()) {
        // Otra pestana ya lo refresco; no hay nada que hacer.
        return
      }

      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Lumon-Build': BUILD_SHA,
        },
        body: JSON.stringify({ refreshToken: storedRefreshToken }),
      })

      if (!res.ok) {
        const body = await safeJson(res)
        // REFRESH_REUSED, TOKEN_INVALID, etc. la sesion ya esta muerta.
        clearSession()
        throw new ApiError(res.status, body)
      }

      const tokens = (await res.json()) as TokenPair
      saveTokens(tokens)
    }

    if (typeof navigator !== 'undefined' && navigator.locks) {
      await navigator.locks.request('lumon.refresh', runCriticalSection)
    } else {
      await runCriticalSection()
    }
  })()

  try {
    await refreshInFlight
  } finally {
    refreshInFlight = null
  }
}

function emptyError(code: string): ApiErrorBody {
  return {
    error: code,
    message: code,
    details: null,
    timestamp: new Date().toISOString(),
    path: '',
    requestId: '',
  }
}

async function safeJson(res: Response): Promise<ApiErrorBody> {
  try {
    return (await res.json()) as ApiErrorBody
  } catch {
    return emptyError('UNKNOWN_ERROR')
  }
}

/**
 * fetch con: base URL, header X-Lumon-Build, Authorization automatico,
 * refresh transparente coordinado entre pestanas via Web Locks, y errores
 * tipados (ApiError) en vez de parsear JSON en cada llamada.
 *
 * Usen SIEMPRE esta funcion en vez de fetch() directo, o se pierde la
 * coordinacion del refresh y una recarga con dos pestanas abiertas puede
 * disparar REFRESH_REUSED y cerrar la sesion del equipo entero.
 */
export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const { auth = true, body, headers, extraHeaders, ...rest } = options

  // Refresh preventivo si sabemos que esta por vencer.
  if (auth && isAccessTokenExpired() && getStoredRefreshToken()) {
    await refreshAccessToken()
  }

  const buildHeaders = (): HeadersInit => ({
    'X-Lumon-Build': BUILD_SHA,
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(auth && getAccessToken() ? { Authorization: `Bearer ${getAccessToken()}` } : {}),
    ...extraHeaders,
    ...headers,
  })

  const doFetch = () =>
    fetch(`${API_BASE}${path}`, {
      ...rest,
      headers: buildHeaders(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })

  let res = await doFetch()

  // Reintento uno a uno: token expiro justo entre el chequeo y la llegada
  // de la respuesta (ventana corta, 180s por defecto). Solo si el codigo
  // de error es TOKEN_EXPIRED, no cualquier 401.
  if (res.status === 401 && auth) {
    const clone = res.clone()
    const errBody = await safeJson(clone)
    if (errBody.error === 'TOKEN_EXPIRED' && getStoredRefreshToken()) {
      await refreshAccessToken()
      res = await doFetch()
    }
  }

  if (!res.ok) {
    const errBody = await safeJson(res)
    const retryAfterHeader = Number(res.headers.get('Retry-After'))
    const retryAfter = Number.isFinite(retryAfterHeader) && retryAfterHeader >= 0 ? retryAfterHeader : null
    throw new ApiError(res.status, errBody, res.headers.has('Retry-After') ? retryAfter : null)
  }

  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

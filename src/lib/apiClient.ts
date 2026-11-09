import { ApiError, type ApiErrorBody, type TokenPair } from './types'
import {
  getAccessToken,
  getStoredRefreshToken,
  isAccessTokenExpired,
  saveTokens,
  clearSession,
} from './session'

const API_BASE = import.meta.env.VITE_API_BASE_URL as string

// El SHA del commit, inyectado por Vite (ver vite.config.ts). El backend lo
// exige en cada request del navegador que NO sea localhost; mandarlo
// siempre es inofensivo y evita tener que acordarse en el momento del deploy.
const BUILD_SHA = __LUMON_BUILD_SHA__

interface ApiFetchOptions extends Omit<RequestInit, 'body'> {
  body?: unknown
  /** Pasar false solo para endpoints publicos (login/register/refresh). */
  auth?: boolean
}

// --- Refresh con un solo vuelo en curso --------------------------------
// "Si varias requests reciben TOKEN_EXPIRED a la vez, hagan UN SOLO refresh
// y compartanlo." Si dos refresh llegan con el mismo refreshToken (ya
// consumido), el backend revoca la sesion COMPLETA. Por eso todo el mundo
// espera a la misma promesa en vez de llamar a /auth/refresh por su cuenta.
let refreshInFlight: Promise<TokenPair> | null = null

async function refreshAccessToken(): Promise<TokenPair> {
  if (refreshInFlight) return refreshInFlight

  refreshInFlight = (async () => {
    // Releer de localStorage por si OTRA pestaña ya roto el token mientras
    // esta esperaba.
    const refreshToken = getStoredRefreshToken()
    if (!refreshToken) throw new ApiError(401, emptyError('NO_REFRESH_TOKEN'))

    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Lumon-Build': BUILD_SHA },
      body: JSON.stringify({ refreshToken }),
    })

    if (!res.ok) {
      const body = await safeJson(res)
      // REFRESH_REUSED u otro 401: la sesion ya esta muerta, hay que
      // mandar al usuario de vuelta al login.
      clearSession()
      throw new ApiError(res.status, body)
    }

    const tokens = (await res.json()) as TokenPair
    saveTokens(tokens)
    return tokens
  })()

  try {
    return await refreshInFlight
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
 * refresh transparente si el access token esta vencido, y errores tipados
 * (ApiError) en vez de tener que parsear el JSON a mano en cada llamada.
 */
export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const { auth = true, body, headers, ...rest } = options

  if (auth && isAccessTokenExpired() && getStoredRefreshToken()) {
    await refreshAccessToken()
  }

  const finalHeaders: HeadersInit = {
    'X-Lumon-Build': BUILD_SHA,
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(auth && getAccessToken() ? { Authorization: `Bearer ${getAccessToken()}` } : {}),
    ...headers,
  }

  const doFetch = () =>
    fetch(`${API_BASE}${path}`, {
      ...rest,
      headers: finalHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })

  let res = await doFetch()

  // Reintento de una sola vez: el token expiro justo antes de que llegara
  // la respuesta (la ventana es corta, 180s por defecto).
  if (res.status === 401 && auth) {
    const errBody = await safeJson(res.clone())
    if (errBody.error === 'TOKEN_EXPIRED' && getStoredRefreshToken()) {
      await refreshAccessToken()
      finalHeaders['Authorization' as keyof HeadersInit] = `Bearer ${getAccessToken()}`
      res = await fetch(`${API_BASE}${path}`, {
        ...rest,
        headers: { ...finalHeaders, Authorization: `Bearer ${getAccessToken()}` },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
    }
  }

  if (!res.ok) {
    const errBody = await safeJson(res)
    throw new ApiError(res.status, errBody)
  }

  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

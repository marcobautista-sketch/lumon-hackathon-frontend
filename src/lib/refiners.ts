// Expedientes (CP4). Contrato: GET /departments, GET /refiners, GET /refiners/{id}.
// Los textos vienen DEL EXTERIOR (Regla de la Separacion): se muestran siempre
// como texto con JSX normal, nunca con dangerouslySetInnerHTML.
import { apiFetch } from './apiClient'

export interface Department {
  id: number
  /** Cambia entre workspaces: no hardcodear. */
  code: string
  name: string
}

export interface Badge {
  url: string
  width: number
  height: number
}

export interface Refiner {
  id: number
  fullName: string
  department: Department
  title: string
  extension: string
  bio: string
  profileUrl: string | null
  badge: Badge | null
  /** Aumenta en cada cambio. Es el valor del ETag. */
  version: number
  updatedAt: string
}

export interface PageResponse<T> {
  content: T[]
  totalElements: number
  totalPages: number
  /** Pagina actual, desde 0. */
  page: number
  size: number
}

export const PAGE_SIZES = [10, 25, 50] as const
export type PageSize = (typeof PAGE_SIZES)[number]
export const MAX_QUERY_LENGTH = 60

export interface RefinersQuery {
  page: number
  size: PageSize
  departmentId: number | null
  q: string
}

export function listDepartments(signal?: AbortSignal): Promise<Department[]> {
  return apiFetch<Department[]>('/departments', { signal })
}

export function listRefiners(query: RefinersQuery, signal?: AbortSignal): Promise<PageResponse<Refiner>> {
  const params = new URLSearchParams({ page: String(query.page), size: String(query.size) })
  if (query.departmentId !== null) params.set('departmentId', String(query.departmentId))
  if (query.q) params.set('q', query.q)
  return apiFetch<PageResponse<Refiner>>(`/refiners?${params.toString()}`, { signal })
}

/**
 * Devuelve la URL solo si es http(s). Swagger avisa que profileUrl (y por
 * extension cualquier URL que venga en los datos) puede ser `javascript:` u
 * otro esquema: en ese caso no se enlaza ni se usa como src.
 */
export function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

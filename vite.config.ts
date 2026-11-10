import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { execSync } from 'node:child_process'

// SHA del commit desplegado, inyectado en build time para la cabecera
// X-Lumon-Build que exige el backend desde produccion.
//   1. Vercel pone VERCEL_GIT_COMMIT_SHA (40 chars hex) automaticamente.
//   2. En build local lo leemos con git.
//   3. Fallback a 'dev' (solo vale desde localhost).
function resolveBuildSha(): string {
  const vercelSha = process.env.VERCEL_GIT_COMMIT_SHA
  if (vercelSha && /^[0-9a-f]{7,40}$/.test(vercelSha)) return vercelSha
  try {
    const out = execSync('git rev-parse HEAD').toString().trim()
    if (/^[0-9a-f]{7,40}$/.test(out)) return out
  } catch {
    // ignore
  }
  return 'dev'
}

const BUILD_SHA = resolveBuildSha()
// Lo exponemos como env var de Vite para que el bundle lo vea en
// import.meta.env.VITE_LUMON_BUILD_SHA (el define directo a globals no
// siempre sustituye bien en Vite 8).
process.env.VITE_LUMON_BUILD_SHA = BUILD_SHA

export default defineConfig({
  plugins: [react(), tailwindcss()],
})

import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { execSync } from 'node:child_process'

// El backend de Lumon exige el header X-Lumon-Build en cada peticion hecha
// desde produccion: tiene que ser el SHA (corto) del commit con el que se
// construyo la app. Lo resolvemos aqui, en build time, para no depender de
// configurar nada a mano en el panel de Vercel:
//   1. Si Vercel esta construyendo, ya inyecta VERCEL_GIT_COMMIT_SHA solo.
//   2. Si no (build local), lo leemos con git.
//   3. Si tampoco hay git disponible, 'dev' (vale en localhost).
function resolveBuildSha(): string {
  const vercelSha = process.env.VERCEL_GIT_COMMIT_SHA
  if (vercelSha) return vercelSha.slice(0, 40)
  try {
    return execSync('git rev-parse --short HEAD').toString().trim()
  } catch {
    return 'dev'
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __LUMON_BUILD_SHA__: JSON.stringify(resolveBuildSha()),
  },
})

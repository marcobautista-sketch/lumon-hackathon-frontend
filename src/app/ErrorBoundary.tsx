import { Component, type ErrorInfo, type ReactNode } from 'react'

interface State {
  error: Error | null
}

/**
 * Captura errores de render en cualquier ruta. CP6: "Un error de render
 * en una ruta no deja la app en blanco: se muestra un error con opcion de
 * volver".
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // En produccion los logs no se envian a ningun lado. Para debug local:
    console.error('ErrorBoundary:', error, info.componentStack)
  }

  reset = () => this.setState({ error: null })

  render() {
    if (!this.state.error) return this.props.children
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-3 bg-slate-950 px-4 text-slate-100">
        <h1 className="text-2xl font-semibold">Algo se rompio</h1>
        <p className="max-w-md text-center text-sm text-slate-400">
          {this.state.error.message || 'Error desconocido.'}
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => (window.location.href = '/')}
            className="rounded bg-slate-200 px-4 py-2 font-medium text-slate-900"
          >
            Volver al inicio
          </button>
          <button
            type="button"
            onClick={this.reset}
            className="rounded border border-slate-700 px-4 py-2"
          >
            Reintentar
          </button>
        </div>
      </main>
    )
  }
}

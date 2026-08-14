import { createElement, useCallback, useEffect, useRef, useState } from 'react'
import { BROWSER_PARTITION } from '@/types/api'

const FACTORY_URL = 'http://localhost:4600'

interface FactoryWebviewElement extends HTMLElement {
  reload(): void
  loadURL?(url: string): Promise<void>
}

/**
 * Frames the SSSF visualizer (the factory's shipped watch-screen) served on
 * localhost:4600 by `just obs` in a factory-enabled project. Prototype: the
 * panel embeds, it does not start the server — the empty state says how.
 */
export function FactoryPanel() {
  const viewRef = useRef<FactoryWebviewElement | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const onFail = () => setFailed(true)
    const onLoad = () => setFailed(false)
    view.addEventListener('did-fail-load', onFail)
    view.addEventListener('did-finish-load', onLoad)
    return () => {
      view.removeEventListener('did-fail-load', onFail)
      view.removeEventListener('did-finish-load', onLoad)
    }
  }, [])

  const retry = useCallback(() => {
    setFailed(false)
    viewRef.current?.reload()
  }, [])

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', display: 'flex' }}>
      {createElement('webview' as never, {
        ref: (node: FactoryWebviewElement | null) => { viewRef.current = node },
        src: FACTORY_URL,
        partition: BROWSER_PARTITION,
        webpreferences: 'contextIsolation=yes,sandbox=yes,nodeIntegration=no',
        style: { flex: 1, width: '100%', height: '100%' },
      })}
      {failed ? (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, textAlign: 'center', padding: 24 }}>
          <p style={{ margin: 0, opacity: 0.85 }}>The factory watch-screen isn&apos;t running.</p>
          <p style={{ margin: 0, opacity: 0.6 }}>Start it in your project with <code>just obs</code>, then retry.</p>
          <button type="button" onClick={retry}>Retry</button>
        </div>
      ) : null}
    </div>
  )
}

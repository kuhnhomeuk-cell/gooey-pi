import { createElement, useCallback, useEffect, useState, type CSSProperties } from 'react'
import { errorMessage } from '@/lib/errors'
import { BROWSER_PARTITION, type FactoryStatus } from '@/types/api'

const NO_FACTORY = 'This project has no factory yet. Double-click the Install Factory app on the Desktop, drop this project\'s folder on it, then come back.'

const overlayStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 12,
  textAlign: 'center',
  padding: 24,
}

export function FactoryPanel({ cwd }: { cwd?: string }) {
  const [status, setStatus] = useState<FactoryStatus>({ state: 'none' })
  const [url, setUrl] = useState<string | undefined>()
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (!cwd || !window.prime) {
      setStatus({ state: 'none' })
      setUrl(undefined)
      return
    }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    setUrl(undefined)
    setStatus({ state: 'starting' })

    const apply = (next: FactoryStatus) => {
      if (cancelled) return
      setStatus(next)
      if (next.state === 'running' && next.url) setUrl(next.url)
    }

    const poll = async () => {
      if (cancelled || !window.prime) return
      try {
        const next = await window.prime.factory.status(cwd)
        apply(next)
        if (!cancelled && next.state !== 'running' && next.state !== 'error' && next.state !== 'none') {
          timer = setTimeout(() => { void poll() }, 1_500)
        }
      } catch (error) {
        apply({ state: 'error', message: errorMessage(error) })
      }
    }

    void window.prime.factory.ensure(cwd).then((next) => {
      apply(next)
      if (!cancelled && next.state !== 'running' && next.state !== 'error' && next.state !== 'none') {
        timer = setTimeout(() => { void poll() }, 1_500)
      }
    }).catch((error: unknown) => {
      apply({ state: 'error', message: errorMessage(error) })
    })

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [cwd, nonce])

  const retry = useCallback(() => { setNonce((value) => value + 1) }, [])

  const overlay = status.state === 'running' && url
    ? null
    : status.state === 'error'
      ? <div style={overlayStyle}><p style={{ margin: 0, opacity: 0.85 }}>{status.message || 'The factory watch-screen failed to start.'}</p><button type="button" onClick={retry}>Retry</button></div>
      : status.state === 'installing' || status.state === 'starting'
        ? <div style={overlayStyle}><p style={{ margin: 0, opacity: 0.85 }}>Starting the factory watch-screen\u2026</p></div>
        : <div style={overlayStyle}><p style={{ margin: 0, opacity: 0.85 }}>{NO_FACTORY}</p></div>

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', display: 'flex' }}>
      {url ? createElement('webview' as never, {
        src: url,
        partition: BROWSER_PARTITION,
        webpreferences: 'contextIsolation=yes,sandbox=yes,nodeIntegration=no',
        style: { flex: 1, width: '100%', height: '100%' },
      }) : null}
      {overlay}
    </div>
  )
}

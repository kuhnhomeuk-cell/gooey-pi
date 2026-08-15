import { createElement, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { errorMessage } from '@/lib/errors'
import { BROWSER_PARTITION, type FactoryStatus } from '@/types/api'

const NO_FACTORY = 'This project has no factory yet. Double-click the Install Factory app on the Desktop, drop this project\'s folder on it, then come back.'
const LOAD_FAILED = 'The factory watch-screen failed to load.'

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
  const webviewRef = useRef<HTMLElement | null>(null)
  const guestFailedRef = useRef(false)

  useEffect(() => {
    if (!cwd || !window.prime) {
      setStatus({ state: 'none' })
      setUrl(undefined)
      return
    }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    guestFailedRef.current = false
    setUrl(undefined)
    setStatus({ state: 'starting' })

    const apply = (next: FactoryStatus) => {
      if (cancelled || guestFailedRef.current) return
      setStatus(next)
      if (next.state === 'running' && next.url) setUrl(next.url)
      else setUrl(undefined)
    }

    const shouldPoll = (next: FactoryStatus): boolean => {
      return !cancelled && !guestFailedRef.current && next.state !== 'error' && next.state !== 'none'
    }

    const poll = async () => {
      if (cancelled || guestFailedRef.current || !window.prime) return
      try {
        const next = await window.prime.factory.status(cwd)
        apply(next)
        if (shouldPoll(next)) timer = setTimeout(() => { void poll() }, 1_500)
      } catch (error) {
        apply({ state: 'error', message: errorMessage(error) })
      }
    }

    void window.prime.factory.ensure(cwd).then((next) => {
      apply(next)
      if (shouldPoll(next)) timer = setTimeout(() => { void poll() }, 1_500)
    }).catch((error: unknown) => {
      apply({ state: 'error', message: errorMessage(error) })
    })

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [cwd, nonce])

  useEffect(() => {
    const view = webviewRef.current
    if (!view || !url) return
    const fail = () => {
      guestFailedRef.current = true
      setUrl(undefined)
      setStatus({ state: 'error', message: LOAD_FAILED })
      if (cwd && window.prime) void window.prime.factory.ensure(cwd)
    }
    view.addEventListener('did-fail-load', fail)
    view.addEventListener('did-fail-provisional-load', fail)
    return () => {
      view.removeEventListener('did-fail-load', fail)
      view.removeEventListener('did-fail-provisional-load', fail)
    }
  }, [cwd, url])

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
        ref: (node: HTMLElement | null) => { webviewRef.current = node },
      }) : null}
      {overlay}
    </div>
  )
}

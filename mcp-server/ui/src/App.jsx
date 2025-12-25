import React, { useEffect, useMemo, useState } from 'react'
import {
  Header, HeaderName, Content, SideNav, SideNavItems, SideNavLink, Theme,
  Tile, Tag, InlineNotification, CodeSnippet
} from '@carbon/react'
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom'
import '@carbon/styles/css/styles.css'

const NAV = [
  { path:'/rx-agent', label:'Received from AI Agent' },
  { path:'/tx-maximo', label:'Sent to Maximo Tenant' },
  { path:'/rx-maximo', label:'Received from Maximo Tenant' },
  { path:'/tx-agent', label:'Sent to AI Agent' }
]

function usePath() { return useLocation().pathname }

async function fetchLogs() {
  const r = await fetch('/api/logs?limit=200')
  const raw = await r.text()
  if (!r.ok) throw new Error(raw || `HTTP ${r.status}`)
  return JSON.parse(raw)
}

function LogList({ kind }) {
  const [data, setData] = useState({ events: [] })
  const [err, setErr] = useState(null)

  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const j = await fetchLogs()
        if (!alive) return
        setData(j)
        setErr(null)
      } catch (e) {
        if (!alive) return
        setErr(String(e.message || e))
      }
    }
    tick()
    const t = setInterval(tick, 1500)
    return () => { alive = false; clearInterval(t) }
  }, [])

  const filtered = useMemo(() => (data.events || []).filter(e => e.kind === kind).slice().reverse(), [data, kind])

  return (
    <div style={{ maxWidth: 1180 }}>
      <div style={{ display:'flex', gap:'0.5rem', alignItems:'center', marginBottom:'0.75rem' }}>
        <Tag type="blue">{kind}</Tag>
        <div style={{ opacity:0.8 }}>Live view (polling)</div>
      </div>
      {err ? <InlineNotification kind="error" title="Logs unavailable" subtitle={err} /> : null}

      {filtered.map((e, idx) => (
        <Tile key={idx} style={{ marginBottom:'0.75rem' }}>
          <div style={{ display:'flex', justifyContent:'space-between', gap:'1rem' }}>
            <div style={{ fontWeight:600 }}>{new Date(e.ts).toLocaleString()}</div>
            <div style={{ opacity:0.85 }}>{e.tenant ? `tenant=${e.tenant}` : ''}</div>
          </div>
          {e.meta ? (
            <div style={{ marginTop:'0.5rem', opacity:0.85 }}>
              {Object.entries(e.meta).map(([k,v]) => (
                <span key={k} style={{ marginRight:'1rem' }}><b>{k}</b>: {String(v)}</span>
              ))}
            </div>
          ) : null}
          <div style={{ marginTop:'0.75rem' }}>
            <CodeSnippet type="multi" wrapText>{typeof e.payload === 'string' ? e.payload : JSON.stringify(e.payload, null, 2)}</CodeSnippet>
          </div>
        </Tile>
      ))}
    </div>
  )
}

function Shell({ children }) {
  const nav = useNavigate()
  const path = usePath()
  return (
    <Theme theme="g10">
      <Header aria-label="MCP Server Trace">
        <HeaderName prefix="ZNAPZ">MCP Server</HeaderName>
      </Header>
      <SideNav expanded aria-label="MCP nav" style={{ background:'#000' }}>
        <SideNavItems>
          {NAV.map(i => (
            <SideNavLink key={i.path} isActive={path===i.path} onClick={() => nav(i.path)} style={{ color:'#fff' }}>
              {i.label}
            </SideNavLink>
          ))}
        </SideNavItems>
      </SideNav>
      <Content style={{ marginLeft:256, padding:'1rem 1.25rem' }}>
        {children}
      </Content>
    </Theme>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <Shell>
        <Routes>
          <Route path="/" element={<Navigate to="/rx-agent" replace />} />
          <Route path="/rx-agent" element={<LogList kind="rx_agent" />} />
          <Route path="/tx-maximo" element={<LogList kind="tx_maximo" />} />
          <Route path="/rx-maximo" element={<LogList kind="rx_maximo" />} />
          <Route path="/tx-agent" element={<LogList kind="tx_agent" />} />
          <Route path="*" element={<Navigate to="/rx-agent" replace />} />
        </Routes>
      </Shell>
    </BrowserRouter>
  )
}

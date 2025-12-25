import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  Header, HeaderName, HeaderGlobalBar, HeaderGlobalAction,
  Content, SideNav, SideNavItems, SideNavLink, Theme,
  Button, TextInput, Dropdown, Modal, Tabs, Tab, Tile, Tag,
  DataTable, TableContainer, Table, TableHead, TableRow, TableHeader, TableBody, TableCell,
  InlineNotification, TextArea, Toggle, CodeSnippet, Loading
} from '@carbon/react'
import { Chat, Settings, Help, Code, Moon, Sun } from '@carbon/icons-react'
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom'
import './overrides.css'

const SETTINGS_KEY = 'mx_settings_v3'

const PROVIDERS = [
  { id:'openai', label:'OpenAI (OpenAI API)' },
  { id:'anthropic', label:'Anthropic' },
  { id:'gemini', label:'Google Gemini' },
  { id:'mistral', label:'Mistral' },
  { id:'deepseek', label:'DeepSeek' },
  { id:'watsonx', label:'IBM watsonx' }
]

const MAXIMO_PROMPTS = [
  'Show me all locations',
  'Show me all assets',
  'Show me all open work orders',
  'Show me all corrective work orders',
  'Show me all service requests',
  'Show me all inventory',
  'Summarize the last Maximo results'
]

const AI_PROMPTS = [
  'Create a extended summary of our conversation',
  'Create an Executive Summary of our conversation',
  'Provide me the reasoning, evidence and confidence score behind your response',
  "Explain like I'm not familiar with Maximo or Asset Management"
]

function loadLocalSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') } catch { return {} }
}
function saveLocalSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s || {}))
}

async function apiGetSettings() {
  const r = await fetch('/api/settings')
  if (!r.ok) throw new Error(`Failed to load settings (${r.status})`)
  return await r.json()
}

async function apiSaveSettings(payload) {
  const r = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'content-type':'application/json' },
    body: JSON.stringify(payload || {})
  })
  if (!r.ok) throw new Error(`Failed to save settings (${r.status})`)
  return await r.json()
}

async function apiListModels(provider, settings) {
  const r = await fetch(`/api/models?provider=${encodeURIComponent(provider||'')}`, {
    method: 'POST',
    headers: { 'content-type':'application/json' },
    body: JSON.stringify({ settings: settings || {} })
  })
  const ct = (r.headers.get('content-type') || '').toLowerCase()
  const raw = await r.text()
  if (!r.ok) throw new Error(raw || `Failed to load models (${r.status})`)
  if (ct.includes('application/json')) return JSON.parse(raw)
  throw new Error(`Unexpected response (not JSON): ${raw.slice(0,160)}`)
}

async function apiAgentChat({ provider, model, system, temperature, text, settings }) {
  const r = await fetch('/api/agent/chat', {
    method:'POST',
    headers:{'content-type':'application/json'},
    body: JSON.stringify({ provider, model, system, temperature, text, settings })
  })
  const ct = (r.headers.get('content-type') || '').toLowerCase()
  const raw = await r.text()
  if (!r.ok) {
    // surface HTML / proxy pages as readable text
    const detail = raw.slice(0, 400)
    throw new Error(detail || `AI request failed (${r.status})`)
  }
  if (ct.includes('application/json')) return JSON.parse(raw)
  throw new Error(`Unexpected response (not JSON): ${raw.slice(0,160)}`)
}

async function apiMaximoNL({ text, settings }) {
  const r = await fetch('/api/maximo/query', {
    method:'POST',
    headers:{'content-type':'application/json'},
    body: JSON.stringify({ text, settings })
  })
  const ct = (r.headers.get('content-type') || '').toLowerCase()
  const raw = await r.text()
  if (!r.ok) throw new Error(raw || `Maximo request failed (${r.status})`)
  if (ct.includes('application/json')) return JSON.parse(raw)
  throw new Error(`Unexpected response (not JSON): ${raw.slice(0,160)}`)
}

function useHashRoute() {
  const loc = useLocation()
  return loc.pathname
}

function Shell({ children, theme, onToggleTheme, onOpenSettings, onOpenHelp }) {
  const route = useHashRoute()
  const nav = useNavigate()
  const isActive = (p) => route === p

  return (
    <Theme theme={theme === 'dark' ? 'g90' : 'g10'}>
      <div className="mx-shell">
        <Header aria-label="Maximo AI Agent">
          <HeaderName prefix="ZNAPZ">Maximo AI Agent</HeaderName>
          <HeaderGlobalBar>
            <HeaderGlobalAction aria-label="Help" onClick={onOpenHelp}>
              <Help size={20} />
            </HeaderGlobalAction>
            <HeaderGlobalAction aria-label="Settings" onClick={onOpenSettings}>
              <Settings size={20} />
            </HeaderGlobalAction>
            <HeaderGlobalAction aria-label="Toggle theme" onClick={onToggleTheme}>
              {theme === 'dark' ? <Sun size={20}/> : <Moon size={20}/>}
            </HeaderGlobalAction>
          </HeaderGlobalBar>
        </Header>

        <SideNav aria-label="Side navigation" expanded className="mx-sidenav">
          <SideNavItems>
            <SideNavLink isActive={isActive('/chat')} onClick={() => nav('/chat')} renderIcon={Chat}>
              Chat
            </SideNavLink>
            <SideNavLink isActive={isActive('/rest')} onClick={() => nav('/rest')} renderIcon={Code}>
              REST Builder & Trace
            </SideNavLink>
            <SideNavLink isActive={isActive('/settings')} onClick={() => nav('/settings')} renderIcon={Settings}>
              Settings
            </SideNavLink>
            <SideNavLink isActive={isActive('/help')} onClick={() => nav('/help')} renderIcon={Help}>
              Help
            </SideNavLink>
          </SideNavItems>
        </SideNav>

        <Content className="mx-content">
          {children}
        </Content>
      </div>
    </Theme>
  )
}

function ChatBubble({ side, title, children, subtle }) {
  return (
    <div className={`mx-bubble-row ${side}`}>
      <Tile className={`mx-bubble ${subtle ? 'subtle':''}`}>
        {title ? <div className="mx-bubble-title">{title}</div> : null}
        <div className="mx-bubble-body">{children}</div>
      </Tile>
    </div>
  )
}

function Chips({ title, items, onPick }) {
  return (
    <div className="mx-chips">
      <div className="mx-chips-title">{title}</div>
      <div className="mx-chips-row">
        {items.map((t) => (
          <button key={t} className="mx-chip" onClick={() => onPick(t)}>{t}</button>
        ))}
      </div>
    </div>
  )
}

function ChatPage({ settings, setSettings, setLastTrace, setLastMaximoTable }) {
  const [mode, setMode] = useState(settings?.ui?.mode || 'ai') // ai|maximo
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState(null)
  const [messages, setMessages] = useState([]) // {role:'user'|'assistant', text, source}
  const listRef = useRef(null)

  useEffect(() => {
    const s = { ...(settings||{}) }
    s.ui = { ...(s.ui||{}), mode }
    setSettings(s)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  useEffect(() => {
    if (!listRef.current) return
    listRef.current.scrollTop = listRef.current.scrollHeight
  }, [messages, busy])

  const onSend = async (text) => {
    const t = (text ?? input).trim()
    if (!t) return
    setNote(null)
    setBusy(true)
    setInput('')
    setMessages((m) => [...m, { role:'user', text:t, source: mode }])

    try {
      if (mode === 'ai') {
        const resp = await apiAgentChat({
          provider: settings?.ai?.provider || 'openai',
          model: settings?.ai?.model || '',
          system: settings?.ai?.system || '',
          temperature: settings?.ai?.temperature ?? 0.7,
          text: t,
          settings
        })
        setMessages((m) => [...m, { role:'assistant', text: resp.reply || '', source:'ai' }])
      } else {
        const resp = await apiMaximoNL({ text: t, settings })
        setLastTrace(resp.trace || null)
        if (resp.table) setLastMaximoTable(resp.table)
        if (resp.table) {
          setMessages((m) => [...m, { role:'assistant', text:`Retrieved ${resp.table.rows.length} row(s) from Maximo.`, source:'maximo', table: resp.table }])
        } else {
          setMessages((m) => [...m, { role:'assistant', text: resp.summary || 'Maximo query completed.', source:'maximo' }])
        }
      }
    } catch (e) {
      setMessages((m) => [...m, { role:'assistant', text: `Error: ${e.message || e}`, source: mode }])
      setNote({ kind:'error', title:'Request failed', subtitle: String(e.message || e) })
    } finally {
      setBusy(false)
    }
  }

  const latestTable = useMemo(() => {
    for (let i = messages.length-1; i>=0; i--) if (messages[i].table) return messages[i].table
    return null
  }, [messages])

  return (
    <div className="mx-page">
      <div className="mx-toolbar">
        <div className="mx-toolbar-left">
          <Tag type={mode === 'ai' ? 'green' : 'blue'}>{mode === 'ai' ? 'AI' : 'Maximo'}</Tag>
          <div className="mx-mode">
            <Toggle
              id="mode-toggle"
              labelText=""
              labelA="AI"
              labelB="Maximo"
              toggled={mode === 'maximo'}
              onToggle={(v) => setMode(v ? 'maximo' : 'ai')}
            />
          </div>
          <div className="mx-subtle">Deployed on OpenShift</div>
        </div>
        <div className="mx-toolbar-right">
          {busy ? <Loading small withOverlay={false} description="Working..." /> : null}
        </div>
      </div>

      {note ? (
        <InlineNotification kind={note.kind} title={note.title} subtitle={note.subtitle} />
      ) : null}

      <div className="mx-chat-layout">
        <div className="mx-chat" ref={listRef}>
          {messages.map((m, idx) => (
            <div key={idx}>
              <ChatBubble
                side={m.role === 'user' ? 'right' : 'left'}
                title={m.role === 'user' ? 'You' : (m.source === 'maximo' ? 'Maximo' : 'AI Agent')}
                subtle={m.role === 'user'}
              >
                <div style={{ whiteSpace:'pre-wrap' }}>{m.text}</div>
                {m.table ? <MaximoTable table={m.table}/> : null}
              </ChatBubble>
            </div>
          ))}
          {busy ? (
            <ChatBubble side="left" title={mode === 'maximo' ? 'Maximo' : 'AI Agent'}>
              Thinking…
            </ChatBubble>
          ) : null}
        </div>

        <div className="mx-sidepanel">
          <Chips title="Predefined Prompt Examples — Maximo" items={MAXIMO_PROMPTS} onPick={(t) => {
            // convenience: "Show me all assets" maps to your prompt style
            onSend(t.toLowerCase().includes('show me') ? t.replace(/^Show me/i,'Show me') : t)
          }} />
          <Chips title="Predefined Prompt Examples — AI" items={AI_PROMPTS} onPick={(t) => onSend(t)} />

          {latestTable ? (
            <div className="mx-hint">
              <div className="mx-hint-title">Last Maximo table</div>
              <div className="mx-hint-body">{latestTable.title} ({latestTable.rows.length} rows)</div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="mx-inputbar">
        <TextInput
          id="chat-input"
          labelText=""
          placeholder={mode === 'ai' ? 'Ask the AI…' : 'Describe the Maximo data you want…'}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend() } }}
        />
        <Button onClick={() => onSend()} disabled={busy || !input.trim()}>Send</Button>
      </div>
    </div>
  )
}

function MaximoTable({ table }) {
  const { columns, rows, title } = table
  const headers = columns.map((c) => ({ key: c, header: c.toUpperCase() }))
  const tableRows = rows.map((r, i) => {
    const obj = { id: String(i) }
    columns.forEach((c) => { obj[c] = r[c] ?? '' })
    return obj
  })

  return (
    <div style={{ marginTop: '0.75rem' }}>
      <DataTable rows={tableRows} headers={headers} isSortable>
        {({ rows, headers, getHeaderProps, getRowProps, getTableProps }) => (
          <TableContainer title={title || 'Results'} description="">
            <Table {...getTableProps()} size="sm" useZebraStyles>
              <TableHead>
                <TableRow>
                  {headers.map((h) => (
                    <TableHeader key={h.key} {...getHeaderProps({ header: h })}>
                      {h.header}
                    </TableHeader>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id} {...getRowProps({ row })}>
                    {row.cells.map((cell) => (
                      <TableCell key={cell.id}>{cell.value}</TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </DataTable>
    </div>
  )
}

function RestPage({ lastTrace, settings, setLastTrace }) {
  const [method, setMethod] = useState('GET')
  const [os, setOs] = useState(settings?.maximo?.objectStructure || 'mxapiasset')
  const [where, setWhere] = useState('')
  const [select, setSelect] = useState('')
  const [orderBy, setOrderBy] = useState('')
  const [pageSize, setPageSize] = useState('50')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState(null)

  useEffect(() => {
    setOs(settings?.maximo?.objectStructure || os)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.maximo?.objectStructure])

  const run = async () => {
    setNote(null)
    setBusy(true)
    try {
      const r = await fetch('/api/maximo/raw', {
        method:'POST',
        headers:{'content-type':'application/json'},
        body: JSON.stringify({
          method, os, where, select, orderBy, pageSize, body,
          settings
        })
      })
      const ct = (r.headers.get('content-type') || '').toLowerCase()
      const raw = await r.text()
      if (!r.ok) throw new Error(raw || `Request failed (${r.status})`)
      const json = ct.includes('application/json') ? JSON.parse(raw) : { raw }
      setLastTrace(json.trace || json)
      setNote({ kind:'success', title:'Request executed', subtitle:'Trace updated' })
    } catch (e) {
      setNote({ kind:'error', title:'Request failed', subtitle: String(e.message || e) })
    } finally {
      setBusy(false)
    }
  }

  const trace = lastTrace || null

  return (
    <div className="mx-page">
      <div className="mx-page-title">REST Builder & Trace</div>
      <div className="mx-subtle">Transparent REST traceability</div>

      {note ? <InlineNotification kind={note.kind} title={note.title} subtitle={note.subtitle} /> : null}

      <Tabs>
        <Tab id="tab-build" label="Build Request">
          <div className="mx-form-grid">
            <Dropdown
              id="br-method"
              titleText="Method"
              label="Select method"
              items={['GET','POST','PATCH']}
              selectedItem={method}
              onChange={({ selectedItem }) => setMethod(selectedItem)}
            />
            <TextInput id="br-os" labelText="Object Structure" value={os} onChange={(e) => setOs(e.target.value)} />
            <TextArea id="br-where" labelText="oslc.where" value={where} onChange={(e) => setWhere(e.target.value)} />
            <TextInput id="br-select" labelText="oslc.select" value={select} onChange={(e) => setSelect(e.target.value)} />
            <TextInput id="br-order" labelText="oslc.orderBy" value={orderBy} onChange={(e) => setOrderBy(e.target.value)} />
            <TextInput id="br-page" labelText="oslc.pageSize" value={pageSize} onChange={(e) => setPageSize(e.target.value)} />
            <TextArea id="br-body" labelText="Body (POST/PATCH)" value={body} onChange={(e) => setBody(e.target.value)} />
            <div className="mx-form-actions">
              <Button onClick={run} disabled={busy}>Run</Button>
              <Button kind="secondary" onClick={() => setLastTrace(null)} disabled={busy}>Clear Trace</Button>
            </div>
          </div>
        </Tab>

        <Tab id="tab-preview" label="Preview">
          <Tile>
            <div className="mx-subtle">Computed URL preview is shown in Trace after you Run.</div>
            <div style={{ marginTop:'0.5rem' }}>
              <CodeSnippet type="multi" wrapText>
                {trace?.request?.url || trace?.url || '—'}
              </CodeSnippet>
            </div>
          </Tile>
        </Tab>

        <Tab id="tab-response" label="Response">
          <Tile>
            <div className="mx-subtle">Raw response payload (from last request)</div>
            <div style={{ marginTop:'0.5rem' }}>
              <CodeSnippet type="multi" wrapText>
                {trace?.response?.body || trace?.responseRaw || (trace ? JSON.stringify(trace, null, 2) : '—')}
              </CodeSnippet>
            </div>
          </Tile>
        </Tab>
      </Tabs>
    </div>
  )
}

function SettingsPage({ settings, setSettings }) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState(null)
  const [models, setModels] = useState([])
  const [modelsBusy, setModelsBusy] = useState(false)

  const s = settings || {}
  const ai = s.ai || {}
  const maximo = s.maximo || {}
  const tenants = s.tenants || [{ id:'default', label:'Default', url: maximo.baseUrl || '' }]

  const set = (path, value) => {
    const next = JSON.parse(JSON.stringify(s || {}))
    let cur = next
    for (let i=0; i<path.length-1; i++) {
      cur[path[i]] = cur[path[i]] || {}
      cur = cur[path[i]]
    }
    cur[path[path.length-1]] = value
    setSettings(next)
  }

  const loadModels = async () => {
    setModelsBusy(true)
    setNote(null)
    try {
      const out = await apiListModels(ai.provider || 'openai', s)
      const list = out.models || []
      setModels(list)
      if (!ai.model && list.length) set(['ai','model'], list[0])
    } catch (e) {
      setModels([])
      setNote({ kind:'error', title:'Model list failed', subtitle: String(e.message || e) })
    } finally {
      setModelsBusy(false)
    }
  }

  useEffect(() => {
    loadModels()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ai.provider])

  const save = async () => {
    setSaving(true); setNote(null)
    try {
      await apiSaveSettings(s)
      saveLocalSettings(s)
      setNote({ kind:'success', title:'Saved', subtitle:'Settings persisted to PVC-backed file.' })
    } catch (e) {
      setNote({ kind:'error', title:'Save failed', subtitle: String(e.message || e) })
    } finally {
      setSaving(false)
    }
  }

  const addTenant = () => {
    const next = { ...(s||{}) }
    next.tenants = [...(next.tenants||tenants), { id:'', label:'', url:'' }]
    setSettings(next)
  }
  const delTenant = (idx) => {
    const next = { ...(s||{}) }
    const copy = [...(next.tenants||tenants)]
    if (copy[idx]?.id === 'default') return
    copy.splice(idx,1)
    next.tenants = copy
    setSettings(next)
  }

  return (
    <div className="mx-page">
      <div className="mx-page-title">Settings</div>
      <div className="mx-subtle">Credentials are stored in OpenShift Secrets and mirrored into a PVC-backed settings file.</div>

      {note ? <InlineNotification kind={note.kind} title={note.title} subtitle={note.subtitle} /> : null}

      <div className="mx-form-grid">
        <Dropdown
          id="ai-provider"
          titleText="AI Provider"
          label="Select provider"
          items={PROVIDERS}
          itemToString={(it) => it ? it.label : ''}
          selectedItem={PROVIDERS.find(p => p.id === (ai.provider||'openai'))}
          onChange={({ selectedItem }) => set(['ai','provider'], selectedItem?.id || 'openai')}
        />

        <div>
          <div className="cds--label">Model</div>
          <div style={{ display:'flex', gap:'0.5rem', alignItems:'center' }}>
            <Dropdown
              id="ai-model"
              label={modelsBusy ? 'Loading…' : 'Select model'}
              titleText=""
              items={models.length ? models : (ai.model ? [ai.model] : [])}
              selectedItem={ai.model || (models[0] || '')}
              itemToString={(it) => String(it || '')}
              onChange={({ selectedItem }) => set(['ai','model'], String(selectedItem||''))}
              disabled={modelsBusy || (!models.length && !ai.model)}
            />
            <Button size="sm" kind="secondary" onClick={loadModels} disabled={modelsBusy}>
              Refresh
            </Button>
          </div>
        </div>

        <TextArea
          id="ai-system"
          labelText="System Prompt"
          value={ai.system || ''}
          onChange={(e) => set(['ai','system'], e.target.value)}
        />

        <TextInput
          id="ai-temp"
          labelText="Temperature"
          value={String(ai.temperature ?? 0.7)}
          onChange={(e) => set(['ai','temperature'], Number(e.target.value || 0.7))}
        />

        <TextInput
          id="maximo-url"
          labelText="Maximo Base URL"
          helperText="Example: https://yourhost/maximo (API uses /maximo/api/os)"
          value={maximo.baseUrl || ''}
          onChange={(e) => set(['maximo','baseUrl'], e.target.value)}
        />
        <TextInput
          id="maximo-key"
          labelText="Maximo API Key"
          value={maximo.apiKey || ''}
          type="password"
          onChange={(e) => set(['maximo','apiKey'], e.target.value)}
        />
        <TextInput
          id="maximo-site"
          labelText="Default Site ID"
          value={maximo.defaultSite || ''}
          onChange={(e) => set(['maximo','defaultSite'], e.target.value.toUpperCase())}
        />
        <TextInput
          id="maximo-os"
          labelText="Object Structure"
          helperText="Used for Maximo mode and REST Builder"
          value={maximo.objectStructure || 'mxapiasset'}
          onChange={(e) => set(['maximo','objectStructure'], e.target.value)}
        />

        <TextInput
          id="mcp-url"
          labelText="MCP Server URL"
          value={s.mcp?.url || ''}
          onChange={(e) => set(['mcp','url'], e.target.value)}
        />
        <Toggle
          id="mcp-tools"
          labelText="Enable MCP tool orchestration in AI mode (OpenAI-compatible providers only)"
          toggled={!!(s.mcp?.enableTools)}
          onToggle={(v) => set(['mcp','enableTools'], !!v)}
        />
      </div>

      <div className="mx-section">
        <div className="mx-section-title">Tenants Registry</div>
        <div className="mx-subtle">Add, edit, and remove tenants. Stored in the PVC-backed settings file.</div>

        <div className="mx-tenant-table">
          <div className="mx-tenant-row head">
            <div>Tenant ID</div><div>Label</div><div>Maximo Base URL</div><div></div>
          </div>
          {(s.tenants || tenants).map((t, idx) => (
            <div className="mx-tenant-row" key={idx}>
              <TextInput id={`t-id-${idx}`} labelText="" value={t.id||''}
                onChange={(e) => {
                  const next = { ...(s||{}) }; const copy=[...(next.tenants||tenants)]
                  copy[idx] = { ...(copy[idx]||{}), id: e.target.value }
                  next.tenants = copy; setSettings(next)
                }} />
              <TextInput id={`t-label-${idx}`} labelText="" value={t.label||''}
                onChange={(e) => {
                  const next = { ...(s||{}) }; const copy=[...(next.tenants||tenants)]
                  copy[idx] = { ...(copy[idx]||{}), label: e.target.value }
                  next.tenants = copy; setSettings(next)
                }} />
              <TextInput id={`t-url-${idx}`} labelText="" value={t.url||''}
                onChange={(e) => {
                  const next = { ...(s||{}) }; const copy=[...(next.tenants||tenants)]
                  copy[idx] = { ...(copy[idx]||{}), url: e.target.value }
                  next.tenants = copy; setSettings(next)
                }} />
              <Button size="sm" kind="danger--tertiary" onClick={() => delTenant(idx)} disabled={(t.id||'')==='default'}>
                Delete
              </Button>
            </div>
          ))}
          <div style={{ marginTop:'0.75rem' }}>
            <Button kind="secondary" onClick={addTenant}>Add tenant</Button>
          </div>
        </div>
      </div>

      <div className="mx-form-actions">
        <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save Settings'}</Button>
      </div>
    </div>
  )
}

function HelpPage() {
  return (
    <div className="mx-page">
      <div className="mx-page-title">Help & User Guide</div>
      <Tile style={{ marginTop:'1rem' }}>
        <div className="mx-subtle">
          This assistant supports two modes: AI (general LLM answers) and Maximo (query IBM Maximo via REST).
          Use Settings to configure your providers and Maximo connection.
        </div>
        <ul style={{ marginTop:'0.75rem' }}>
          <li><b>AI mode</b>: chat with the selected provider. Optionally enable MCP tool orchestration.</li>
          <li><b>Maximo mode</b>: natural language prompts map to /maximo/api/os queries and return a table.</li>
          <li><b>REST Builder & Trace</b>: manually build and execute OSLC requests; inspect trace and payload.</li>
        </ul>
      </Tile>
    </div>
  )
}

function RouterApp({ settings, setSettings, lastTrace, setLastTrace, setLastMaximoTable }) {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/chat" replace/>} />
      <Route path="/chat" element={<ChatPage settings={settings} setSettings={setSettings} setLastTrace={setLastTrace} setLastMaximoTable={setLastMaximoTable} />} />
      <Route path="/rest" element={<RestPage lastTrace={lastTrace} settings={settings} setLastTrace={setLastTrace} />} />
      <Route path="/settings" element={<SettingsPage settings={settings} setSettings={setSettings} />} />
      <Route path="/help" element={<HelpPage />} />
      <Route path="*" element={<Navigate to="/chat" replace/>} />
    </Routes>
  )
}

export default function App() {
  const [theme, setTheme] = useState(() => (localStorage.getItem('mx_theme') || 'light'))
  const [settings, setSettings] = useState(() => loadLocalSettings())
  const [lastTrace, setLastTrace] = useState(null)
  const [lastMaximoTable, setLastMaximoTable] = useState(null)

  const [helpOpen, setHelpOpen] = useState(false)

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    localStorage.setItem('mx_theme', next)
  }

  // Merge PVC/Secret settings into local settings on load
  useEffect(() => {
    (async () => {
      try {
        const s = await apiGetSettings()
        // normalize structure expected by UI
        const merged = {
          ...settings,
          ai: {
            provider: (settings.ai?.provider || s.openai_key ? 'openai' : 'openai'),
            model: settings.ai?.model || '',
            system: settings.ai?.system || '',
            temperature: settings.ai?.temperature ?? 0.7,
            ...settings.ai
          },
          maximo: {
            baseUrl: settings.maximo?.baseUrl || s.maximo_url || '',
            apiKey: settings.maximo?.apiKey || s.maximo_apikey || '',
            defaultSite: (settings.maximo?.defaultSite || s.default_siteid || '').toUpperCase(),
            objectStructure: settings.maximo?.objectStructure || s.maximo_os || 'mxapiasset'
          },
          mcp: {
            url: settings.mcp?.url || s.mcp_url || '',
            enableTools: settings.mcp?.enableTools ?? (String(s.enable_mcp_tools||'').toLowerCase()==='true')
          },
          tenants: settings.tenants || s.tenants || [{ id:'default', label:'Default', url: (settings.maximo?.baseUrl || s.maximo_url || '') }]
        }
        setSettings(merged)
        saveLocalSettings(merged)
      } catch (e) {
        // ignore; user can still configure locally
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <BrowserRouter>
      <Shell
        theme={theme}
        onToggleTheme={toggleTheme}
        onOpenSettings={() => {}}
        onOpenHelp={() => setHelpOpen(true)}
      >
        <RouterApp
          settings={settings}
          setSettings={(s) => { setSettings(s); saveLocalSettings(s) }}
          lastTrace={lastTrace}
          setLastTrace={setLastTrace}
          setLastMaximoTable={setLastMaximoTable}
        />

        <Modal
          open={helpOpen}
          modalHeading="Help"
          primaryButtonText="Close"
          onRequestClose={() => setHelpOpen(false)}
          onRequestSubmit={() => setHelpOpen(false)}
        >
          <HelpPage />
        </Modal>
      </Shell>
    </BrowserRouter>
  )
}

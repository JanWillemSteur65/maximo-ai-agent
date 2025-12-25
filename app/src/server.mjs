import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";

const app = express();

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "base-uri": ["'self'"],
      "object-src": ["'none'"],
      "img-src": ["'self'", "data:"],
      "font-src": ["'self'", "data:"],
      "style-src": ["'self'"],
      "script-src": ["'self'"],
      "connect-src": ["'self'"],
      "frame-ancestors": ["'none'"]
    }
  },
  referrerPolicy: { policy: "no-referrer" },
  crossOriginEmbedderPolicy: false
}));

app.use(morgan("combined"));
app.use(express.json({ limit: "5mb" }));

const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || "/data";
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

function envSettings() {
  return {
    maximo_url: process.env.MAXIMO_URL,
    maximo_apikey: process.env.MAXIMO_APIKEY,
    maximo_user: process.env.MAXIMO_USER,
    maximo_password: process.env.MAXIMO_PASSWORD,
    default_siteid: process.env.DEFAULT_SITEID,
    maximo_tenant: process.env.MAXIMO_TENANT || "default",
    tenants: process.env.TENANTS_JSON ? JSON.parse(process.env.TENANTS_JSON) : undefined,
    enable_mcp_tools: process.env.ENABLE_MCP_TOOLS === "true" || process.env.ENABLE_MCP_TOOLS === "1",
    mcp_url: process.env.MCP_URL,
    openai_key: process.env.OPENAI_API_KEY,
    openai_base: process.env.OPENAI_BASE,
    anthropic_key: process.env.ANTHROPIC_API_KEY,
    anthropic_base: process.env.ANTHROPIC_BASE,
    gemini_key: process.env.GEMINI_API_KEY,
    gemini_base: process.env.GEMINI_BASE,
    mistral_key: process.env.MISTRAL_API_KEY,
    mistral_base: process.env.MISTRAL_BASE,
    deepseek_key: process.env.DEEPSEEK_API_KEY,
    deepseek_base: process.env.DEEPSEEK_BASE,
    watsonx_api_key: process.env.WATSONX_API_KEY,
    watsonx_region: process.env.WATSONX_REGION,
    watsonx_project: process.env.WATSONX_PROJECT,
    watsonx_base: process.env.WATSONX_BASE
  };
}

function readFileSettings() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return {};
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function writeFileSettings(obj) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(obj, null, 2), "utf-8");
}

app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.get("/api/settings", (_req, res) => {
  const merged = { ...envSettings(), ...readFileSettings() };
  res.json(merged);
});

app.post("/api/settings", (req, res) => {
  const body = req.body || {};
  // Do not blindly persist provider keys if you rely on OpenShift Secrets.
  // Persisting is enabled here because your requirement explicitly asks for PVC storage too.
  writeFileSettings(body);
  res.json({ ok: true });
});

// Agent orchestration endpoint remains from prior versions for OpenAI-compatible tool calling

app.post("/api/agent/chat", async (req, res) => {
  try {
    const provider = String(req.body?.provider || "openai").toLowerCase();
    const model = String(req.body?.model || "").trim();
    const system = String(req.body?.system || "").trim();
    const temperature = Number.isFinite(Number(req.body?.temperature)) ? Number(req.body.temperature) : 0.7;
    const text = String(req.body?.text || "").trim();
    const settings = req.body?.settings || {};
    const mcp = settings.mcp || {};
    const enableTools = !!mcp.enableTools;
    const mcpUrl = String(mcp.url || "").trim();
    const tenant = (settings.maximo?.defaultTenant || settings.maximo_tenant || "default").toString();

    const secrets = settings.secrets || settings;

    const getKey = (k, envk) => String(secrets?.[k] || process.env[envk] || "").trim();
    const getBase = (k, envk, defv) => String(secrets?.[k] || process.env[envk] || defv || "").trim().replace(/\/$/,"");

    const messages = [];
    if (system) messages.push({ role: "system", content: system });
    messages.push({ role: "user", content: text });

    // ---- OpenAI-compatible chat (OpenAI/Mistral/DeepSeek) ----
    
function toOpenAITools(tools) {
  const list = Array.isArray(tools) ? tools : [];
  const out = [];
  for (const t of list) {
    // already OpenAI-ready
    if (t && t.type === "function" && t.function && t.function.name) {
      out.push({
        type: "function",
        function: {
          name: String(t.function.name),
          description: String(t.function.description || ""),
          parameters: (t.function.parameters && typeof t.function.parameters === "object")
            ? t.function.parameters
            : { type: "object", properties: {}, additionalProperties: true }
        }
      });
      continue;
    }
    // MCP-native
    const name = String(t?.name || "").trim();
    if (!name) continue;
    out.push({
      type: "function",
      function: {
        name,
        description: String(t?.description || ""),
        parameters: (t?.inputSchema && typeof t.inputSchema === "object")
          ? t.inputSchema
          : { type: "object", properties: {}, additionalProperties: true }
      }
    });
  }
  return out;
}

async function openaiCompatChat(base, apiKey, compatModel, tools) {
      const url = `${base}/v1/chat/completions`;
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type":"application/json", "authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: compatModel || model || "gpt-4o-mini",
          temperature,
          messages,
          tools: tools?.length ? tools : undefined,
          tool_choice: tools?.length ? "auto" : undefined
        })
      });
      const raw = await r.text();
      const ct = (r.headers.get("content-type") || "").toLowerCase();
      let j = null;
      if (ct.includes("application/json")) { try { j = JSON.parse(raw) } catch { j = null } }
      if (!r.ok) throw new Error(j?.error?.message || raw.slice(0,400));
      return j;
    }

    // ---- Anthropic messages API (minimal) ----
    async function anthropicChat(apiKey, anthropicModel) {
      const base = getBase("anthropic_base", "ANTHROPIC_BASE", "https://api.anthropic.com");
      const url = `${base}/v1/messages`;
      const r = await fetch(url, {
        method:"POST",
        headers: {
          "content-type":"application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: anthropicModel || model || "claude-3-5-sonnet-latest",
          max_tokens: 1024,
          temperature,
          system: system || undefined,
          messages: [{ role:"user", content: text }]
        })
      });
      const raw = await r.text();
      const ct = (r.headers.get("content-type") || "").toLowerCase();
      let j = null;
      if (ct.includes("application/json")) { try { j = JSON.parse(raw) } catch { j = null } }
      if (!r.ok) throw new Error(j?.error?.message || raw.slice(0,400));
      const out = (j?.content || []).map(x => x?.text).filter(Boolean).join("
");
      return { reply: out };
    }

    // ---- Gemini generateContent (minimal) ----
    async function geminiChat(apiKey, geminiModel) {
      const base = getBase("gemini_base", "GEMINI_BASE", "https://generativelanguage.googleapis.com");
      const m = geminiModel || model || "gemini-1.5-flash";
      const url = `${base}/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const r = await fetch(url, {
        method:"POST",
        headers: { "content-type":"application/json" },
        body: JSON.stringify({
          contents: [{ role:"user", parts: [{ text }] }],
          generationConfig: { temperature }
        })
      });
      const raw = await r.text();
      const ct = (r.headers.get("content-type") || "").toLowerCase();
      let j=null;
      if (ct.includes("application/json")) { try { j=JSON.parse(raw) } catch { j=null } }
      if (!r.ok) throw new Error((j && JSON.stringify(j).slice(0,400)) || raw.slice(0,400));
      const cand = j?.candidates?.[0]?.content?.parts?.map(p=>p.text).filter(Boolean).join("
") || "";
      return { reply: cand };
    }

    // ---- watsonx text generation (best-effort; depends on instance) ----
    async function watsonxChat(apiKey, wxModel) {
      const base = getBase("watsonx_base", "WATSONX_BASE", "https://us-south.ml.cloud.ibm.com");
      const project = getKey("watsonx_project", "WATSONX_PROJECT");
      if (!project) throw new Error("Missing watsonx project id (watsonx_project)");
      const url = `${base}/ml/v1/text/generation?version=2024-05-01`;
      const r = await fetch(url, {
        method:"POST",
        headers: { "content-type":"application/json", "authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({
          model_id: wxModel || model || "ibm/granite-13b-chat-v2",
          input: system ? `${system}

User: ${text}
Assistant:` : text,
          parameters: { temperature, max_new_tokens: 1024 },
          project_id: project
        })
      });
      const raw = await r.text();
      const ct = (r.headers.get("content-type") || "").toLowerCase();
      let j=null;
      if (ct.includes("application/json")) { try { j=JSON.parse(raw) } catch { j=null } }
      if (!r.ok) throw new Error(raw.slice(0,400));
      const out = j?.results?.[0]?.generated_text || "";
      return { reply: out };
    }

    // Tool orchestration supported for OpenAI-compatible providers only (OpenAI/Mistral/DeepSeek)
    const openaiCompatProviders = new Set(["openai","mistral","deepseek"]);
    if (enableTools && mcpUrl && !openaiCompatProviders.has(provider)) {
      // tools are disabled for other providers in this build
    }

    if (openaiCompatProviders.has(provider)) {
      const keyName = provider === "openai" ? "openai_key" : (provider === "mistral" ? "mistral_key" : "deepseek_key");
      const baseName = provider === "openai" ? "openai_base" : (provider === "mistral" ? "mistral_base" : "deepseek_base");
      const apiKey = getKey(keyName, provider.toUpperCase() + "_API_KEY");
      const base = getBase(baseName, provider.toUpperCase() + "_BASE", provider === "openai" ? "https://api.openai.com" : "");
      if (!apiKey) return res.status(400).json({ error:"missing_api_key", detail:`Missing ${provider} API key` });
      if (!base) return res.status(400).json({ error:"missing_base", detail:`Missing ${provider} base URL` });

      // no tools: plain chat
      if (!(enableTools && mcpUrl)) {
        const out = await openaiCompatChat(base, apiKey, model, []);
        const reply = out?.choices?.[0]?.message?.content || "";
        return res.json({ reply });
      }

      // tools: load from MCP and run tool-call loop
      const toolsResp = await fetch(`${mcpUrl}/mcp/tools?tenant=${encodeURIComponent(tenant)}`);
      const toolsText = await toolsResp.text();
      let toolsJson = null;
      try { toolsJson = JSON.parse(toolsText); } catch { toolsJson = null; }
      const rawTools = Array.isArray(toolsJson?.tools) ? toolsJson.tools : [];
      const tools = toOpenAITools(rawTools);

      let loopMessages = messages.slice();
      for (let i = 0; i < 6; i++) {
        const out = await openaiCompatChat(base, apiKey, model, tools);
        const msg = out?.choices?.[0]?.message || {};
        const toolCalls = msg?.tool_calls || [];
        const content = msg?.content || "";

        if (!toolCalls.length) return res.json({ reply: content });

        // append assistant with tool_calls
        loopMessages.push({ role:"assistant", content, tool_calls: toolCalls });

        for (const tc of toolCalls) {
          const name = tc?.function?.name;
          const argsStr = tc?.function?.arguments || "{}";
          let args = {};
          try { args = JSON.parse(argsStr) } catch { args = { raw: argsStr } }
          const callResp = await fetch(`${mcpUrl}/mcp/call`, {
            method:"POST",
            headers:{ "content-type":"application/json" },
            body: JSON.stringify({ name, args, tenant })
          });
          const callJson = await callResp.json();
          loopMessages.push({ role:"tool", tool_call_id: tc.id, content: JSON.stringify(callJson) });
        }

        // update messages reference for next loop
        messages.length = 0;
        loopMessages.forEach(m => messages.push(m));
      }
      return res.json({ reply: "Tool orchestration exceeded max iterations." });
    }

    if (provider === "anthropic") {
      const apiKey = getKey("anthropic_key","ANTHROPIC_API_KEY");
      if (!apiKey) return res.status(400).json({ error:"missing_api_key", detail:"Missing anthropic API key" });
      const out = await anthropicChat(apiKey, model);
      return res.json(out);
    }

    if (provider === "gemini") {
      const apiKey = getKey("gemini_key","GEMINI_API_KEY");
      if (!apiKey) return res.status(400).json({ error:"missing_api_key", detail:"Missing gemini API key" });
      const out = await geminiChat(apiKey, model);
      return res.json(out);
    }

    if (provider === "watsonx") {
      const apiKey = getKey("watsonx_api_key","WATSONX_API_KEY");
      if (!apiKey) return res.status(400).json({ error:"missing_api_key", detail:"Missing watsonx API key (bearer/IAM token)" });
      const out = await watsonxChat(apiKey, model);
      return res.json(out);
    }

    return res.status(400).json({ error:"unsupported_provider", detail:`Provider not supported: ${provider}` });
  } catch (e) {
    return res.status(500).json({ error:"agent_failed", detail:String(e?.message || e) });
  }
});


// Generic proxy: used for Maximo REST calls and non-orchestrated provider calls
app.post("/proxy", async (req, res) => {
  const { method, url, headers, payload } = req.body || {};
  if (!method || !url) return res.status(400).json({ error: "method and url are required" });

  try {
    const resp = await fetch(url, {
      method,
      headers: headers || {},
      body: ["GET", "HEAD"].includes(String(method).toUpperCase()) ? undefined : JSON.stringify(payload ?? {}),
    });

    const contentType = resp.headers.get("content-type") || "";
    const text = await resp.text();

    res.status(resp.status);
    if (contentType.includes("application/json")) {
      try { return res.json(JSON.parse(text)); } catch { return res.type("application/json").send(text); }
    }
    return res.type(contentType || "text/plain").send(text);
  } catch (e) {
    return res.status(502).json({ error: "proxy_failed", detail: String(e) });
  }
});

app.use(express.static(path.join(process.cwd(), "public")));
app.get("*", (_req, res) => res.sendFile(path.join(process.cwd(), "public", "index.html")));



// ---- AI model listing (best-effort) ----
app.post("/api/models", async (req, res) => {
  try {
    const provider = String(req.query.provider || req.body?.provider || "openai").toLowerCase();
    const settings = req.body?.settings || {};
    const ai = settings.ai || {};

    // read per-provider key/base from settings; fallback to envSettings()/file settings already merged client-side
    const get = (k) => (ai && ai[k]) || (settings && settings[k]) || "";
    const openaiKey = get("openai_key") || process.env.OPENAI_API_KEY || settings?.openai_key || "";
    const openaiBase = (get("openai_base") || process.env.OPENAI_BASE || "https://api.openai.com").replace(/\/$/,"");

    // Curated fallback lists (keeps UI usable even if provider blocks model listing)
    const curated = {
      openai: ["gpt-4o-mini","gpt-4.1-mini","gpt-4o","gpt-4.1"],
      mistral: ["mistral-large-latest","mistral-small-latest","open-mistral-nemo"],
      deepseek: ["deepseek-chat","deepseek-reasoner"],
      anthropic: ["claude-3-5-sonnet-latest","claude-3-5-haiku-latest"],
      gemini: ["gemini-1.5-pro","gemini-1.5-flash","gemini-2.0-flash"],
      watsonx: ["ibm/granite-20b-multilingual","ibm/granite-13b-chat-v2"]
    };

    if (provider === "openai" && openaiKey) {
      const r = await fetch(`${openaiBase}/v1/models`, {
        headers: { "authorization": `Bearer ${openaiKey}` }
      });
      const ct = (r.headers.get("content-type") || "").toLowerCase();
      const raw = await r.text();
      if (!r.ok) {
        return res.json({ models: curated.openai, warning: `OpenAI /v1/models failed (${r.status})`, detail: raw.slice(0,200) });
      }
      if (ct.includes("application/json")) {
        const j = JSON.parse(raw);
        const ids = (j?.data || []).map(x => x.id).filter(Boolean);
        const filtered = ids.filter(id => /gpt|o\d|chat/i.test(id)).slice(0,200);
        return res.json({ models: filtered.length ? filtered : curated.openai });
      }
      return res.json({ models: curated.openai, warning: "OpenAI returned non-JSON model list" });
    }

    return res.json({ models: curated[provider] || curated.openai });
  } catch (e) {
    return res.json({ models: ["gpt-4o-mini"], warning: String(e?.message || e) });
  }
});

// ---- Maximo helpers ----
function normMaximoBase(url) {
  let u = String(url || "").trim();
  if (!u) return "";
  u = u.replace(/\/$/,"");
  if (!/\/maximo$/.test(u)) u = u + "/maximo";
  return u;
}
function maximoApiBase(base) {
  const b = normMaximoBase(base);
  if (!b) return "";
  return b.replace(/\/maximo$/,"/maximo/api");
}
function quoteWhereValue(v) {
  // OSLC where values should be quoted when strings.
  const s = String(v ?? "").trim();
  if (!s) return "";
  if (/^\d+(\.\d+)?$/.test(s)) return s;
  // escape double quotes
  return `"${s.replace(/"/g,'\\"')}"`;
}
function extractRows(maximoJson) {
  // Maximo OSLC commonly uses "member" array; sometimes "rdfs:member"
  const arr = maximoJson?.member || maximoJson?.["rdfs:member"] || maximoJson?.response?.member;
  return Array.isArray(arr) ? arr : [];
}

app.post("/api/maximo/query", async (req, res) => {
  try {
    const text = String(req.body?.text || "").trim();
    const settings = req.body?.settings || {};
    const maximo = settings.maximo || {};
    const baseUrl = maximo.baseUrl || settings.maximo_url || process.env.MAXIMO_URL;
    const apiKey = maximo.apiKey || settings.maximo_apikey || process.env.MAXIMO_APIKEY;
    const siteid = (maximo.defaultSite || settings.default_siteid || process.env.DEFAULT_SITEID || "").toString().toUpperCase();
    const os = (maximo.objectStructure || settings.maximo_os || "mxapiasset").trim();

    if (!baseUrl || !apiKey) return res.status(400).json({ error: "missing_maximo_config", detail: "Configure Maximo Base URL and API Key in Settings." });

    const api = maximoApiBase(baseUrl);
    const method = "GET";
    let where = "";
    let select = "";
    let orderBy = "";
    let pageSize = "50";

    // Minimal NL mapping for common built-in prompts
    const t = text.toLowerCase();
    if (t.includes("show me all assets") || t === "show all assets") {
      select = "assetnum,description,siteid,location,status,assettype,changedate";
      where = siteid ? `siteid=${quoteWhereValue(siteid)}` : "";
      orderBy = "changedate desc";
      pageSize = "100";
    } else if (t.includes("show me all locations") || t === "show all locations") {
      // typical location OS in Maximo is mxapilocation; if user configured, keep os
      select = "location,description,siteid,type,status,changedate";
      where = siteid ? `siteid=${quoteWhereValue(siteid)}` : "";
      orderBy = "changedate desc";
      pageSize = "100";
    } else if (t.includes("show me all open work orders") || t.includes("open work orders")) {
      select = "wonum,description,status,siteid,assetnum,location,changedate";
      where = `status=${quoteWhereValue("WAPPR")}` + (siteid ? ` and siteid=${quoteWhereValue(siteid)}` : "");
      orderBy = "changedate desc";
      pageSize = "100";
    } else {
      // fallback: if user typed raw where/select patterns, let them provide via REST Builder; here just return guidance
      select = "assetnum,description,siteid";
      where = siteid ? `siteid=${quoteWhereValue(siteid)}` : "";
      pageSize = "50";
    }

    const params = new URLSearchParams();
    if (where) params.set("oslc.where", where);
    if (select) params.set("oslc.select", select);
    if (orderBy) params.set("oslc.orderBy", orderBy);
    if (pageSize) params.set("oslc.pageSize", pageSize);

    const url = `${api}/os/${encodeURIComponent(os)}?${params.toString()}`;

    const r = await fetch(url, {
      method,
      headers: {
        "accept": "application/json",
        "apikey": apiKey
      }
    });
    const bodyText = await r.text();
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    let json = null;
    if (ct.includes("application/json")) {
      try { json = JSON.parse(bodyText); } catch { json = null; }
    }

    if (!r.ok) {
      return res.status(r.status).json({
        error: "maximo_failed",
        trace: { request: { method, url }, response: { status: r.status, body: bodyText.slice(0,2000) } }
      });
    }

    const rowsRaw = json ? extractRows(json) : [];
    // map to tabular
    const cols = (select ? select.split(",").map(x=>x.trim()).filter(Boolean) : Object.keys(rowsRaw[0]||{})).slice(0,30);
    const rows = rowsRaw.map(obj => {
      const row = {};
      cols.forEach(c => row[c] = obj?.[c] ?? "");
      return row;
    });

    return res.json({
      summary: `Retrieved ${rows.length} row(s) from Maximo.`,
      table: { title: `Results · ${os}`, columns: cols, rows },
      trace: { request: { method, url, headers: { apikey: "***" } }, response: { status: r.status, body: bodyText.slice(0,2000) } }
    });
  } catch (e) {
    return res.status(500).json({ error: "maximo_exception", detail: String(e?.message || e) });
  }
});

app.post("/api/maximo/raw", async (req, res) => {
  try {
    const settings = req.body?.settings || {};
    const maximo = settings.maximo || {};
    const baseUrl = maximo.baseUrl || settings.maximo_url || process.env.MAXIMO_URL;
    const apiKey = maximo.apiKey || settings.maximo_apikey || process.env.MAXIMO_APIKEY;

    if (!baseUrl || !apiKey) return res.status(400).json({ error: "missing_maximo_config" });

    const api = maximoApiBase(baseUrl);
    const method = String(req.body?.method || "GET").toUpperCase();
    const os = String(req.body?.os || maximo.objectStructure || "mxapiasset").trim();
    const where = String(req.body?.where || "").trim();
    const select = String(req.body?.select || "").trim();
    const orderBy = String(req.body?.orderBy || "").trim();
    const pageSize = String(req.body?.pageSize || "").trim();
    const body = String(req.body?.body || "").trim();

    const params = new URLSearchParams();
    if (where) params.set("oslc.where", where);
    if (select) params.set("oslc.select", select);
    if (orderBy) params.set("oslc.orderBy", orderBy);
    if (pageSize) params.set("oslc.pageSize", pageSize);

    const url = `${api}/os/${encodeURIComponent(os)}?${params.toString()}`;
    const headers = { "accept":"application/json", "content-type":"application/json", "apikey": apiKey };
    const r = await fetch(url, { method, headers, body: (method === "GET" ? undefined : (body || "{}")) });
    const responseRaw = await r.text();

    return res.status(r.status).json({
      trace: {
        request: { method, url, headers: { ...headers, apikey:"***" }, body: (method === "GET" ? "" : body) },
        response: { status: r.status, body: responseRaw.slice(0,2000) }
      }
    });
  } catch (e) {
    return res.status(500).json({ error: "maximo_raw_exception", detail: String(e?.message || e) });
  }
});

app.listen(PORT, () => console.log(`app listening on :${PORT}`));

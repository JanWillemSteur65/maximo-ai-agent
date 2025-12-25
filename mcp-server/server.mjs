
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import fetch from "node-fetch";
import path from "path";
import fs from "fs";

const app = express();
app.use(helmet());
app.use(morgan("combined"));
app.use(express.json({ limit: "5mb" }));


const LOG_MAX = Number(process.env.LOG_MAX || 500);
const _log = [];
function pushLog(kind, payload, meta = {}, tenant = "") {
  _log.push({ ts: Date.now(), kind, tenant, meta, payload });
  while (_log.length > LOG_MAX) _log.shift();
}
app.get("/api/logs", (req, res) => {
  const limit = Math.min(Number(req.query.limit || 200), LOG_MAX);
  res.json({ events: _log.slice(-limit) });
});

// Serve UI (built into ./public by Vite)
const publicDir = path.join(process.cwd(), "public");
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
  app.get("/", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));
}


const PORT = process.env.PORT || 8081;

/**
 * Tenants config:
 * - Provide a JSON via TENANTS_JSON env, or a file path via TENANTS_FILE.
 * - Each tenant: { baseUrl, apiKey, user, password }
 * Connection ALWAYS uses REST via /maximo/api/os (as per UI buildRequest logic).
 */
function loadTenants() {
  try {
    if (process.env.TENANTS_JSON) return JSON.parse(process.env.TENANTS_JSON);
  } catch {}
  return {
    default: {
      baseUrl: process.env.MAXIMO_URL,
      apiKey: process.env.MAXIMO_APIKEY,
      user: process.env.MAXIMO_USER,
      password: process.env.MAXIMO_PASSWORD
    }
  };
}

function mkBaseApi(base) {
  if (!base) return null;
  let b = String(base).replace(/\/$/, "");
  if (/\/api(\/)?$/.test(b)) return b;
  if (/\/maximo(\/)?$/.test(b)) return b + "/api";
  return b + "/maximo/api";
}

function tenantOrThrow(tenantId) {
  const tenants = loadTenants();
  const t = tenants[tenantId] || tenants.default;
  if (!t || !t.baseUrl) throw new Error("Tenant is not configured: " + tenantId);
  const api = mkBaseApi(t.baseUrl);
  if (!api) throw new Error("Bad Maximo URL for tenant: " + tenantId);
  return { ...t, api };
}


function mcpToOpenAITools(mcpTools) {
  const list = Array.isArray(mcpTools) ? mcpTools : [];
  return list.map(t => ({
    type: "function",
    function: {
      name: String(t?.name || ""),
      description: String(t?.description || ""),
      parameters: (t?.inputSchema && typeof t.inputSchema === "object")
        ? t.inputSchema
        : { type: "object", properties: {}, additionalProperties: true }
    }
  })).filter(x => x.function.name);
}

app.get("/healthz", (_req, res) => res.status(200).json({ ok: true }));

// Minimal "MCP-like" endpoints
app.get("/mcp/tools", (_req, res) => {
  // Return OpenAI tool schema (type:function + function{name,description,parameters})
  const tools = mcpToOpenAITools([

      {
        name: "maximo.listOS",
        description: "List object structures (/os)",
        inputSchema: { type: "object", properties: { }, additionalProperties: false }
      },
      {
        name: "maximo.queryOS",
        description: "Query an object structure with OSLC params",
        inputSchema: {
          type: "object",
          properties: {
            os: { type: "string", description: "Object Structure name (e.g., MXWO)" },
            params: { type: "object", description: "OSLC query params (oslc.where, oslc.select, oslc.pageSize, ...)" }
          },
          required: ["os"],
          additionalProperties: false
        }
      },
      {
        name: "maximo.create",
        description: "Create record in an OS (POST)",
        inputSchema: {
          type: "object",
          properties: {
            os: { type: "string", description: "Object Structure name" },
            body: { type: "object", description: "Record payload" }
          },
          required: ["os", "body"],
          additionalProperties: false
        }
      }
    
  ]);
  res.json({ tools });
});

app.post("/mcp/call", async (req, res) => {
  const body = req.body || {};
  const tool = body.tool || body.name;
  const args = body.args || {};
  const tenantId = (body.tenant || (args && args.tenant) || "default").toString();
  let t;
  try {
    t = tenantOrThrow(tenantId);
  } catch (e) {
    return res.status(400).json({ error: String(e) });
  }

  try {
    if (tool === "maximo.listOS") {
      const url = `${t.api}/os`;
      const r = await fetch(url, { headers: authHeaders(t) });
      return res.status(r.status).json(await r.json());
    }
    if (tool === "maximo.queryOS") {
      const os = args?.os;
      const params = args?.params || {};
      if (!os) return res.status(400).json({ error: "args.os is required" });
      const url = `${t.api}/os/${encodeURIComponent(os)}?` + new URLSearchParams(params).toString();
      const r = await fetch(url, { headers: authHeaders(t) });
      const body = await r.text();
      return res.status(r.status).type(r.headers.get("content-type") || "application/json").send(body);
    }
    if (tool === "maximo.create") {
      const os = args?.os;
      const params = args?.params || { lean: 1 };
      const payload = args?.payload || {};
      if (!os) return res.status(400).json({ error: "args.os is required" });
      const url = `${t.api}/os/${encodeURIComponent(os)}?` + new URLSearchParams(params).toString();
      const r = await fetch(url, { method: "POST", headers: { ...authHeaders(t), "content-type": "application/json" }, body: JSON.stringify(payload) });
      const body = await r.text();
      return res.status(r.status).type(r.headers.get("content-type") || "application/json").send(body);
    }
    return res.status(400).json({ error: "unknown_tool", tool });
  } catch (e) {
    console.error("MCP call failed:", e);
    return res.status(502).json({ error: "mcp_failed", detail: String(e) });
  }
});

function authHeaders(t) {
  // UI uses these headers; keep consistent
  const apiKey = String(t.apiKey || "");
  return {
    accept: "application/json",
    apikey: apiKey,
    "x-api-key": apiKey,
    Authorization: apiKey ? `Apikey ${apiKey}` : undefined
  };
}


// SPA fallback for client-side routes
app.get("/*", (req, res, next) => {
  try {
    const publicDir = path.join(process.cwd(), "public");
    const indexFile = path.join(publicDir, "index.html");
    if (fs.existsSync(indexFile)) return res.sendFile(indexFile);
  } catch {}
  return next();
});

app.listen(PORT, () => console.log(`mcp-server listening on :${PORT}`));

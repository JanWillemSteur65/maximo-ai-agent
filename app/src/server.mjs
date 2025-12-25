import express from "express";
import helmet from "helmet";
import cors from "cors";
import bodyParser from "body-parser";
import morgan from "morgan";
import fetch from "node-fetch";
import { z } from "zod";

/**
 * server.mjs
 *
 * This file runs the “AI Agent” HTTP server.
 * Fix applied: replaced invalid multiline string literals in `.join(" <newline> ")`
 * with `.join('\n')` (2 occurrences: OpenAI + Gemini response parsing).
 */

// -----------------------------
// Env / config
// -----------------------------
const PORT = parseInt(process.env.PORT || "3000", 10);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || "";
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash";

const PROVIDER = (process.env.LLM_PROVIDER || process.env.PROVIDER || "openai").toLowerCase();

const ALLOW_ORIGINS = (process.env.CORS_ORIGINS || "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();

const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS || "60000", 10);

const MCP_SERVER_URL =
  process.env.MCP_SERVER_URL ||
  process.env.MCP_URL ||
  process.env.MCP_ENDPOINT ||
  "";

// -----------------------------
// Helpers
// -----------------------------
function log(...args) {
  if (LOG_LEVEL !== "silent") console.log(...args);
}

function toAbortSignal(timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, cancel: () => clearTimeout(t) };
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function ensureStartsWithSlash(path) {
  if (!path) return "/";
  return path.startsWith("/") ? path : `/${path}`;
}

function normalizeOriginList(list) {
  if (list.length === 1 && list[0] === "*") return "*";
  return list;
}

// -----------------------------
// Validation
// -----------------------------
const ChatRequestSchema = z.object({
  message: z.string().min(1),
  sessionId: z.string().optional(),
  metadata: z.record(z.any()).optional(),
});

const ToolCallSchema = z.object({
  name: z.string(),
  arguments: z.record(z.any()).default({}),
});

const MCPInvokeSchema = z.object({
  tool: z.string(),
  input: z.record(z.any()).default({}),
});

// -----------------------------
// Express app
// -----------------------------
const app = express();

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "default-src": ["'self'"],
        "img-src": ["'self'", "data:", "https:"],
        "script-src": ["'self'"],
        "style-src": ["'self'", "'unsafe-inline'"],
      },
    },
  })
);

app.use(
  cors({
    origin: (origin, cb) => {
      const allowed = normalizeOriginList(ALLOW_ORIGINS);
      if (allowed === "*") return cb(null, true);
      if (!origin) return cb(null, true);
      if (allowed.includes(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"), false);
    },
  })
);

app.use(bodyParser.json({ limit: "2mb" }));
app.use(morgan("combined"));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    provider: PROVIDER,
    mcp: Boolean(MCP_SERVER_URL),
    model: PROVIDER === "openai" ? OPENAI_MODEL : GEMINI_MODEL,
  });
});

// -----------------------------
// MCP client
// -----------------------------
async function mcpInvoke({ tool, input }) {
  if (!MCP_SERVER_URL) throw new Error("MCP_SERVER_URL is not configured");

  const url = MCP_SERVER_URL.replace(/\/+$/, "") + ensureStartsWithSlash("/invoke");
  const { signal, cancel } = toAbortSignal(REQUEST_TIMEOUT_MS);

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool, input }),
      signal,
    });

    const raw = await r.text();
    const j = safeJsonParse(raw);

    if (!r.ok) {
      throw new Error(j?.error || j?.message || raw.slice(0, 400));
    }

    return j ?? raw;
  } finally {
    cancel();
  }
}

// -----------------------------
// LLM providers
// -----------------------------
async function callOpenAI({ message }) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");

  const url = `${OPENAI_BASE_URL.replace(/\/+$/, "")}/responses`;
  const payload = {
    model: OPENAI_MODEL,
    input: message,
  };

  const { signal, cancel } = toAbortSignal(REQUEST_TIMEOUT_MS);

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${OPENAI_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      signal,
    });

    const raw = await r.text();
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    let j = null;

    if (ct.includes("application/json")) {
      try {
        j = JSON.parse(raw);
      } catch {
        j = null;
      }
    }

    if (!r.ok) throw new Error(j?.error?.message || raw.slice(0, 400));

    // join must NOT contain a literal newline between quotes
    const out = (j?.content || []).map((x) => x?.text).filter(Boolean).join('\n');
    return { reply: out };
  } finally {
    cancel();
  }
}

async function callGemini({ message }) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured");

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      GEMINI_MODEL
    )}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const payload = {
    contents: [{ role: "user", parts: [{ text: message }] }],
  };

  const { signal, cancel } = toAbortSignal(REQUEST_TIMEOUT_MS);

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });

    const raw = await r.text();
    const j = safeJsonParse(raw);

    if (!r.ok) throw new Error((j && JSON.stringify(j).slice(0, 400)) || raw.slice(0, 400));

    // join must NOT contain a literal newline between quotes
    const cand =
      j?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join('\n') || "";
    return { reply: cand };
  } finally {
    cancel();
  }
}

async function callProvider({ message }) {
  if (PROVIDER === "gemini") return callGemini({ message });
  return callOpenAI({ message });
}

// -----------------------------
// Routes
// -----------------------------
app.post("/chat", async (req, res) => {
  const parsed = ChatRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  }

  const { message } = parsed.data;

  try {
    const out = await callProvider({ message });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.post("/tools/call", async (req, res) => {
  const parsed = ToolCallSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  }

  const { name, arguments: args } = parsed.data;

  try {
    if (name === "mcp.invoke") {
      const p2 = MCPInvokeSchema.safeParse(args);
      if (!p2.success) {
        return res
          .status(400)
          .json({ error: "Invalid mcp.invoke args", details: p2.error.flatten() });
      }
      const r = await mcpInvoke(p2.data);
      return res.json({ ok: true, result: r });
    }

    return res.status(400).json({ error: `Unknown tool: ${name}` });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// -----------------------------
// Startup
// -----------------------------
app.listen(PORT, () => {
  log(`[maximo-ai-agent-app] listening on :${PORT}`);
  log(
    `[maximo-ai-agent-app] provider=${PROVIDER} model=${
      PROVIDER === "openai" ? OPENAI_MODEL : GEMINI_MODEL
    }`
  );
  log(`[maximo-ai-agent-app] mcp=${MCP_SERVER_URL ? MCP_SERVER_URL : "(not configured)"}`);
});


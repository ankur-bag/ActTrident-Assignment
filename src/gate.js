'use strict';

/**
 * Prompt Gate — a small reverse proxy that screens requests before forwarding them.
 *
 * It accepts a JSON body shaped like a model API call, checks the user's text against a list of
 * patterns, and either refuses the request or passes it upstream.
 *
 * This is the code you will be working on.
 */

const http = require('node:http');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const PORT = Number(process.env.GATE_PORT || 7100);
const UPSTREAM = process.env.UPSTREAM_URL || 'http://127.0.0.1:7101';

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------

const CONFIG = {
  // Screening is on unless an operator turns it off.
  screening: { env: 'GATE_SCREENING', default: '1' },
  // block refuses a matching request; warn lets it through with a header.
  mode: { env: 'GATE_MODE', default: 'block' },
};

function conf(name) {
  const spec = CONFIG[name];
  return process.env[spec.env] ?? spec.default;
}

function screeningEnabled() {
  return conf('screening') === '1';
}

function mode() {
  return conf('mode') === 'warn' ? 'warn' : 'block';
}

// ---------------------------------------------------------------------------------------------
// Screening
// ---------------------------------------------------------------------------------------------

const PATTERNS = [
  { re: /ignore (all )?(previous|prior|earlier) instructions/i, say: 'asks the model to ignore earlier instructions' },
  { re: /\.(env|pem)\b|id_rsa|aws\/credentials|api[_-]?key/i, say: 'names credential material' },
  { re: /curl\s+[^\s|]+\s*\|\s*(ba)?sh/i, say: 'contains a download-and-execute command' },
  { re: /reveal|disclose|print.{0,20}(system )?prompt/i, say: 'asks the model to disclose its own instructions' },
];

/** Pull the user-authored text out of the request body. */
function userText(body) {
  const parts = [];
  for (const m of Array.isArray(body?.messages) ? body.messages : []) {
    if (m?.role !== 'user') continue;
    if (typeof m.content === 'string') parts.push(m.content);
    else if (Array.isArray(m.content)) {
      for (const b of m.content) if (typeof b?.text === 'string') parts.push(b.text);
    }
  }
  return parts.join('\n\n');
}

function screen(body) {
  if (!screeningEnabled()) return { findings: [], screened: false };
  const text = userText(body);
  const findings = PATTERNS.filter((p) => p.re.test(text)).map((p) => p.say);
  return { findings, screened: true };
}

// ---------------------------------------------------------------------------------------------
// Proxy
// ---------------------------------------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => resolve(raw));
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

async function forward(path, headers, body, signal) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (['host', 'connection', 'content-length'].includes(k.toLowerCase())) continue;
    out[k] = v;
  }
  return fetch(`${UPSTREAM}${path}`, { method: 'POST', headers: out, body, signal });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    return sendJson(res, 200, { ok: true, screening: screeningEnabled(), mode: mode() });
  }
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });

  const raw = await readBody(req);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return sendJson(res, 400, { error: 'invalid json' });
  }

  const requestId = crypto.randomUUID();
  const { findings } = screen(body);

  if (findings.length > 0 && mode() === 'block') {
    return sendJson(res, 403, {
      error: 'request_blocked',
      why: findings,
      request_id: requestId,
    });
  }

  const controller = new AbortController();
  const onClose = () => controller.abort();
  res.once('close', onClose);
  try {
    const upstream = await forward(req.url, req.headers, raw, controller.signal);
    const streaming = body?.stream === true;
    const text = streaming ? null : await upstream.text();
    const headers = { 'x-gate-request-id': requestId };
    if (findings.length > 0) headers['x-gate-warning'] = findings.join('; ');
    // Fetch decompresses the body; Node supplies framing for the outgoing response.
    const excluded = new Set([
      'content-length', 'content-encoding', 'transfer-encoding', 'connection',
      'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade',
      ...(upstream.headers.get('connection') || '').toLowerCase().split(',').map((h) => h.trim()),
    ]);
    for (const [k, v] of upstream.headers.entries()) {
      if (!excluded.has(k.toLowerCase())) headers[k] = v;
    }
    res.writeHead(upstream.status, headers);
    if (streaming && upstream.body) {
      res.flushHeaders();
      await pipeline(Readable.fromWeb(upstream.body), res);
    } else {
      res.end(text);
    }
  } catch (err) {
    if (res.destroyed) return;
    if (res.headersSent) return res.destroy(err);
    return sendJson(res, 502, { error: 'upstream_unreachable', detail: String(err.message || err) });
  } finally {
    res.off('close', onClose);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  process.stderr.write(`gate on :${PORT} -> ${UPSTREAM}  screening=${screeningEnabled()} mode=${mode()}\n`);
});

module.exports = { screen, userText, PATTERNS };

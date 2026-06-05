/**
 * Cloudflare Pages Function — POST /api/interest
 * ---------------------------------------------------------------------------
 * The always-up FRONT DOOR for guest "interest" submissions from the
 * Things-to-Do area pages. It is deliberately DUMB: it validates, forwards the
 * payload to the n8n webhook (which does the real work — FluentCRM upsert,
 * tags, notifications), and GUARANTEES no submission is ever silently lost.
 *
 * Why this layer exists: n8n runs on a shared Hetzner VPS that is not reliable
 * enough to be the only entry point for guest data. Cloudflare's edge is. So if
 * n8n is unreachable / errors / times out, this function emails Stefano the FULL
 * payload via ZeptoMail (the durable failure record — Pages Function logs do NOT
 * persist) and returns 502 so the page tells the guest to try again.
 *
 * Environment variables (Pages project → Settings → Environment variables, all
 * encrypted):
 *   N8N_WEBHOOK_URL    — the n8n webhook to forward to
 *   N8N_SHARED_SECRET  — added to the forwarded body; n8n's IF-node checks it
 *   ZEPTO_API_TOKEN    — ZeptoMail Send Mail token (verbatim; includes the
 *                        "Zoho-enczapikey " prefix). Used for the failure email.
 *   ALERT_FROM         — (optional) error-email "from", default alerts@amoreparaiso.com
 *   ALERT_TO           — (optional) error-email "to",   default concierge@amoreparaiso.com
 *
 * Pages Functions convention: this file at functions/api/interest.js is served
 * at https://experiences.amoreparaiso.com/api/interest — same origin as the
 * pages, so no CORS complexity (we still set explicit, restrictive CORS).
 */

const ALLOWED_ORIGIN = 'https://experiences.amoreparaiso.com';

// Length caps — generous but bounded, to reject junk / abuse.
const CAPS = {
  name: 120,
  email: 200,
  party_size: 40,
  dates: 120,
  notes: 2000,
  wedding: 80,
  area: 80,
  experience: 160,   // per item
  experiences: 40,   // max items
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function corsHeaders(origin) {
  // Only echo our own origin; everything else gets no ACAO header.
  const allow = origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : '';
  const h = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
  if (allow) h['Access-Control-Allow-Origin'] = allow;
  return h;
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

// CORS preflight. Pages routes OPTIONS here when this export is present.
export async function onRequestOptions({ request }) {
  const origin = request.headers.get('Origin') || '';
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

// Catch-all for any other method (GET/PUT/…): clear 405. POST and OPTIONS are
// handled by their dedicated exports below, which take precedence.
export async function onRequest({ request }) {
  const origin = request.headers.get('Origin') || '';
  return json({ ok: false, error: 'method_not_allowed' }, 405, origin);
}

// The real handler. Pages calls the method-specific export when present.
export async function onRequestPost(context) {
  const { request, env } = context;
  const origin = request.headers.get('Origin') || '';

  // ---- Origin / referer guard (defense in depth; same-origin form anyway) ----
  // Browsers send Origin on cross-origin POSTs; same-origin fetch may omit it,
  // so we accept a missing Origin but reject a present-and-wrong one.
  if (origin && origin !== ALLOWED_ORIGIN) {
    return json({ ok: false, error: 'bad_origin' }, 403, origin);
  }

  // ---- Parse JSON ----
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ ok: false, error: 'bad_json' }, 400, origin);
  }
  if (!data || typeof data !== 'object') {
    return json({ ok: false, error: 'bad_json' }, 400, origin);
  }

  // ---- Honeypot: must be empty ----
  if (str(data.hp) !== '') {
    // Pretend success so bots don't learn anything; nothing is forwarded.
    return json({ ok: true }, 200, origin);
  }

  // ---- Normalize + validate ----
  const name = str(data.name);
  const email = str(data.email);
  const party_size = str(data.party_size);
  const dates = str(data.dates);
  const notes = str(data.notes);
  const wedding = str(data.wedding).toLowerCase();
  const area = str(data.area).toLowerCase();
  let experiences = Array.isArray(data.experiences) ? data.experiences : [];
  experiences = experiences
    .filter((x) => typeof x === 'string')
    .map((x) => x.trim())
    .filter((x) => x.length > 0 && x.length <= CAPS.experience)
    .slice(0, CAPS.experiences);

  const errors = [];
  if (!name || name.length > CAPS.name) errors.push('name');
  if (!email || email.length > CAPS.email || !EMAIL_RE.test(email)) errors.push('email');
  if (experiences.length === 0) errors.push('experiences');
  if (party_size.length > CAPS.party_size) errors.push('party_size');
  if (dates.length > CAPS.dates) errors.push('dates');
  if (notes.length > CAPS.notes) errors.push('notes');
  if (wedding.length > CAPS.wedding) errors.push('wedding');
  if (area.length > CAPS.area) errors.push('area');

  if (errors.length) {
    return json({ ok: false, error: 'validation', fields: errors }, 400, origin);
  }

  // ---- Build the forward payload (adds server-side secret; never in page JS) ----
  const forward = {
    name, email, party_size, dates, notes,
    experiences, wedding, area,
    submitted_at: new Date().toISOString(),
    source: 'experiences.amoreparaiso.com',
    secret: env.N8N_SHARED_SECRET || '',
  };

  // ---- Forward to n8n with a timeout ----
  let n8nOk = false;
  let failureReason = '';
  if (!env.N8N_WEBHOOK_URL) {
    failureReason = 'N8N_WEBHOOK_URL not configured';
  } else {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10000);
      const res = await fetch(env.N8N_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(forward),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (res.ok) {
        n8nOk = true;
      } else {
        failureReason = `n8n responded ${res.status} ${res.statusText}`;
      }
    } catch (e) {
      failureReason = `n8n request failed: ${e && e.name === 'AbortError' ? 'timeout (10s)' : (e && e.message) || 'unknown error'}`;
    }
  }

  if (n8nOk) {
    return json({ ok: true }, 200, origin);
  }

  // ---- NO-DATA-LOSS GUARANTEE: email Stefano the full payload + error ----
  // The forwarded copy we email omits the shared secret.
  const { secret, ...payloadForEmail } = forward;
  await sendFailureEmail(env, payloadForEmail, failureReason).catch(() => {});

  return json({ ok: false, error: 'forward_failed' }, 502, origin);
}

// Formats the durable failure record (subject + full payload) and hands it to
// the ZeptoMail sender. Fires only when the forward to n8n fails.
async function sendFailureEmail(env, payload, reason) {
  if (!env.ZEPTO_API_TOKEN) return; // can't email; 502 still returned by caller

  const lines = [
    'An interest submission could NOT be forwarded to n8n and is recorded here so it is not lost.',
    '',
    `Reason: ${reason}`,
    '',
    `Guest:   ${payload.name} <${payload.email}>`,
    `Party:   ${payload.party_size || '—'}`,
    `Dates:   ${payload.dates || '—'}`,
    `Area:    ${payload.area || '—'}`,
    `Wedding: ${payload.wedding || '—'}`,
    '',
    'Experiences:',
    ...payload.experiences.map((e) => `  • ${e}`),
    '',
    `Notes:   ${payload.notes || '—'}`,
    `When:    ${payload.submitted_at}`,
    '',
    '— Full JSON below —',
    JSON.stringify(payload, null, 2),
  ];

  const subject = `[FAILED INTEREST] ${payload.area || 'area'} · ${payload.name} · ${payload.experiences.length} experience(s)`;
  // reply_to = the guest, so replying to the alert reaches them directly.
  const replyTo = payload.email ? { address: payload.email, name: payload.name || '' } : null;
  await sendAlertEmail(env, subject, lines.join('\n'), replyTo);
}

// Low-level send via ZeptoMail's HTTP API (Workers can't do SMTP). The
// Authorization header is the token verbatim — it already includes the
// "Zoho-enczapikey " prefix, so do NOT add "Bearer".
async function sendAlertEmail(env, subject, textBody, replyTo) {
  const payload = {
    from: { address: env.ALERT_FROM || 'alerts@amoreparaiso.com' },
    to: [{ email_address: { address: env.ALERT_TO || 'concierge@amoreparaiso.com' } }],
    subject,
    textbody: textBody,
  };
  if (replyTo && replyTo.address) {
    payload.reply_to = [{ address: replyTo.address, name: replyTo.name || '' }];
  }
  const resp = await fetch('https://api.zeptomail.com/v1.1/email', {
    method: 'POST',
    headers: {
      'Authorization': env.ZEPTO_API_TOKEN,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    // Last-resort: log so it shows in live-tail. Do not throw — the guest already
    // failed; don't double-fail.
    console.error('ZeptoMail alert failed', resp.status, await resp.text());
  }
}

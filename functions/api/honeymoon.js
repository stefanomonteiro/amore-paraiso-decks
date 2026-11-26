/**
 * Cloudflare Pages Function: POST /api/honeymoon
 * ---------------------------------------------------------------------------
 * "Your week" picks sent by a couple from their private honeymoon options page
 * (/<couple>/private/honeymoon/). Each valid submission is emailed to concierge@
 * via ZeptoMail, one email per version. Nothing is stored anywhere else and
 * nothing goes to FluentCRM. If the email cannot be sent, the page shows the
 * couple their picks to copy into the email thread instead.
 *
 * Environment variables (Pages project > Settings > Environment variables):
 *   ZEPTO_API_TOKEN          already set for /api/interest
 *   ALERT_FROM / ALERT_TO    optional, same defaults as /api/interest
 */

const ALLOWED_ORIGIN = 'https://experiences.amoreparaiso.com';

// Couples whose honeymoon page may post here.
const COUPLES = {
  'brianna-martha': { label: 'Brianna & Martha', nights: 7 },
};

function cors(origin) {
  const h = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
  if (origin === ALLOWED_ORIGIN) h['Access-Control-Allow-Origin'] = ALLOWED_ORIGIN;
  return h;
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(origin) },
  });
}

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const int = (v, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : null);
const money = (n) => '$' + Math.round(n).toLocaleString('en-US');

export async function onRequestOptions({ request }) {
  return new Response(null, { status: 204, headers: cors(request.headers.get('Origin') || '') });
}

export async function onRequest({ request }) {
  return json({ ok: false, error: 'method_not_allowed' }, 405, request.headers.get('Origin') || '');
}

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get('Origin') || '';
  if (origin && origin !== ALLOWED_ORIGIN) return json({ ok: false, error: 'bad_origin' }, 403, origin);

  let d;
  try { d = await request.json(); } catch { return json({ ok: false, error: 'bad_json' }, 400, origin); }
  if (!d || typeof d !== 'object') return json({ ok: false, error: 'bad_json' }, 400, origin);
  if (str(d.hp, 200)) return json({ ok: true }, 200, origin); // honeypot

  const wedding = str(d.wedding, 80).toLowerCase();
  const cfg = COUPLES[wedding];
  const version = int(d.version, 1, 99) || 1;
  const notes = str(d.notes, 1500);
  const stops = (Array.isArray(d.stops) ? d.stops : []).slice(0, 8).map((s) => ({
    hotel: str(s && s.hotel, 120),
    room: str(s && s.room, 120),
    nights: int(s && s.nights, 1, 14),
    price: int(s && s.price, 1, 20000),
  }));

  if (!cfg || !stops.length ||
      stops.some((s) => !s.hotel || !s.room || s.nights === null || s.price === null)) {
    return json({ ok: false, error: 'validation' }, 400, origin);
  }

  // Totals are worked out here from the lines, never taken from the page.
  const nights = stops.reduce((a, s) => a + s.nights, 0);
  const total = stops.reduce((a, s) => a + s.nights * s.price, 0);
  const submitted_at = new Date().toISOString();

  const body = [
    `${cfg.label}: honeymoon picks, version ${version}`,
    '',
    ...stops.map((s) =>
      `${s.nights} night${s.nights === 1 ? '' : 's'}: ${s.hotel}, ${s.room}\n` +
      `    about ${money(s.price)} a night, about ${money(s.nights * s.price)}`),
    '',
    `Nights: ${nights} of ${cfg.nights}`,
    `About ${money(total)} + tax, rooms only (the page's approximate prices)`,
    '',
    `Note: ${notes || 'none'}`,
    '',
    `When: ${submitted_at}`,
  ].join('\n');
  const subject = `Honeymoon picks ${wedding}: version ${version} (${nights} nights, about ${money(total)})`;

  const mailOk = await sendEmail(env, subject, body);
  if (mailOk) return json({ ok: true }, 200, origin);
  return json({ ok: false, error: 'save_failed' }, 502, origin);
}

async function sendEmail(env, subject, textbody) {
  if (!env.ZEPTO_API_TOKEN) return false;
  try {
    const r = await fetch('https://api.zeptomail.com/v1.1/email', {
      method: 'POST',
      headers: { 'Authorization': env.ZEPTO_API_TOKEN, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        from: { address: env.ALERT_FROM || 'alerts@amoreparaiso.com' },
        to: [{ email_address: { address: env.ALERT_TO || 'concierge@amoreparaiso.com' } }],
        subject,
        textbody,
      }),
    });
    if (!r.ok) console.error('ZeptoMail failed', r.status, await r.text());
    return r.ok;
  } catch (e) {
    console.error('ZeptoMail error', e);
    return false;
  }
}

/**
 * Cloudflare Pages Function: POST /api/survey
 * ---------------------------------------------------------------------------
 * Activity survey submissions from /<couple>/survey/ pages.
 * Each valid submission is emailed to concierge@ via ZeptoMail (one email per
 * link, one block per person). Nothing is stored anywhere else. If the email
 * cannot be sent, the guest is asked to try again.
 *
 * Environment variables (Pages project > Settings > Environment variables):
 *   ZEPTO_API_TOKEN          already set for /api/interest
 *   ALERT_FROM / ALERT_TO    optional, same defaults as /api/interest
 */

const ALLOWED_ORIGIN = 'https://experiences.amoreparaiso.com';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Allowed answers per wedding.
const SURVEYS = {
  'allegra-aaron': {
    label: 'Ally & Aaron Wedding Warmup',
    monday: {
      'Individual ATV': 'aa-mon-atv-individual',
      'Shared ATV': 'aa-mon-atv-shared',
      '4x4 with a professional driver': 'aa-mon-4x4-driver',
      'Hotel hiking and pools': 'aa-mon-hotel',
    },
    tuesday: {
      'Rafting': 'aa-tue-rafting',
      'No rafting': 'aa-tue-no-rafting',
    },
  },
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
  const cfg = SURVEYS[wedding];
  const email = str(d.email, 200).toLowerCase();
  const notes = str(d.notes, 1500);
  const people = (Array.isArray(d.people) ? d.people : []).slice(0, 2).map((p) => {
    const monday = str(p && p.monday, 80);
    return {
      name: str(p && p.name, 120),
      monday,
      partner: monday === 'Shared ATV' ? str(p && p.partner, 120) : '',
      tuesday: str(p && p.tuesday, 80),
    };
  });

  if (!cfg || !EMAIL_RE.test(email) || !people.length ||
      people.some((p) => !p.name || !cfg.monday[p.monday] || !cfg.tuesday[p.tuesday])) {
    return json({ ok: false, error: 'validation' }, 400, origin);
  }

  const lead = people[0];
  const submitted_at = new Date().toISOString();

  // Email the answers to concierge@, one block per person
  const body = [
    `${cfg.label}: activity survey`,
    `Email: ${email}`,
    '',
    ...people.flatMap((p) => [
      p.name,
      `  Monday:  ${p.monday}${p.partner ? ` (with ${p.partner})` : ''}`,
      `  Tuesday: ${p.tuesday}`,
      '',
    ]),
    `Notes: ${notes || 'none'}`,
    '',
    `When: ${submitted_at}`,
  ].join('\n');
  const who = people.map((p) => p.name).join(' + ');
  const subject = `Survey ${wedding}: ${who}`;
  const mailOk = await sendEmail(env, subject, body, { address: email, name: lead.name });

  if (mailOk) return json({ ok: true }, 200, origin);
  return json({ ok: false, error: 'save_failed' }, 502, origin);
}

async function sendEmail(env, subject, textbody, replyTo) {
  if (!env.ZEPTO_API_TOKEN) return false;
  try {
    const r = await fetch('https://api.zeptomail.com/v1.1/email', {
      method: 'POST',
      headers: { 'Authorization': env.ZEPTO_API_TOKEN, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        from: { address: env.ALERT_FROM || 'alerts@amoreparaiso.com' },
        to: [{ email_address: { address: env.ALERT_TO || 'concierge@amoreparaiso.com' } }],
        reply_to: [replyTo],
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

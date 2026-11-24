/**
 * Cloudflare Pages Function: POST /api/rooming
 * ---------------------------------------------------------------------------
 * Tent / room plans from couple-only /<couple>/private/rooming/ pages.
 * Each submission is emailed to concierge@ via ZeptoMail. Nothing is stored.
 * Same env vars as /api/survey (ZEPTO_API_TOKEN, optional ALERT_FROM / ALERT_TO).
 */

const ALLOWED_ORIGIN = 'https://experiences.amoreparaiso.com';

// Allowed guests and tent types per wedding (names exactly as shown on the page).
const PLANS = {
  'allegra-aaron': {
    label: 'Ally & Aaron Wedding Warmup: Auralta tents, Jan 5 to 7',
    subject: 'Auralta tent plan',
    types: ['Suite', 'Family', 'Deluxe'],
    unit: 'tents',
    replyTo: { address: 'allyreister@gmail.com', name: 'Ally Reister' },
    caps: { Suite: 2, Deluxe: 2, Family: 4 },
    guests: {
      'Ally and Aaron': 2, 'Brett and Madi': 2, 'Mika and Nolan': 2, 'Camille and Kendrick': 2,
      'Jake and Julia': 2, 'Chris and Francesca': 2, 'Aneesha and Gautham': 2, 'Praniti and Apricot': 2,
      'Hriday and Karly': 2, 'Nitika and Harrison': 2, 'Max Siegelman': 1, 'Abby Bauer': 1,
      'Max Fredkin': 1, 'Corso Rosati': 1, 'Max Savage': 1, 'Will Reister': 1,
    },
  },
  'allegra-aaron-mdf': {
    label: 'Ally & Aaron Wedding Warmup: Montana de Fuego rooms, Jan 3 to 5',
    subject: 'Montana de Fuego room plan',
    types: ['Superior'],
    unit: 'rooms',
    maxKings: 2,
    replyTo: { address: 'allyreister@gmail.com', name: 'Ally Reister' },
    caps: { Superior: 2 },
    guests: {
      'Ally and Aaron': 2, 'Brett and Madi': 2, 'Mika and Nolan': 2, 'Camille and Kendrick': 2,
      'Jake and Julia': 2, 'Chris and Francesca': 2, 'Aneesha and Gautham': 2, 'Praniti and Apricot': 2,
      'Hriday and Karly': 2, 'Nitika and Harrison': 2, 'Max Siegelman': 1, 'Abby Bauer': 1,
      'Max Fredkin': 1, 'Corso Rosati': 1, 'Max Savage': 1, 'Will Reister': 1,
    },
  },
};

function cors(origin) {
  const h = { 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Vary': 'Origin' };
  if (origin === ALLOWED_ORIGIN) h['Access-Control-Allow-Origin'] = ALLOWED_ORIGIN;
  return h;
}
function json(body, status, origin) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors(origin) } });
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
  const cfg = PLANS[wedding];
  if (!cfg || !Array.isArray(d.tents)) return json({ ok: false, error: 'validation' }, 400, origin);

  const seen = new Set();
  const tents = d.tents.slice(0, 30).map((t) => ({
    tent: str(t && t.tent, 40),
    type: str(t && t.type, 20),
    beds: str(t && t.beds, 30),
    guests: (Array.isArray(t && t.guests) ? t.guests : []).slice(0, 4).map((g) => str(g, 80)),
  }));
  for (const t of tents) {
    const cap = cfg.caps[t.type];
    if (!cap || !t.tent || !t.guests.length) return json({ ok: false, error: 'validation' }, 400, origin);
    let n = 0;
    for (const g of t.guests) {
      if (!cfg.guests[g] || seen.has(g)) return json({ ok: false, error: 'validation' }, 400, origin);
      seen.add(g); n += cfg.guests[g];
    }
    if (n > cap) return json({ ok: false, error: 'validation' }, 400, origin);
  }
  if (seen.size !== Object.keys(cfg.guests).length) return json({ ok: false, error: 'validation' }, 400, origin);
  if (cfg.maxKings && tents.filter((t) => t.beds === 'King bed').length > cfg.maxKings) return json({ ok: false, error: 'validation' }, 400, origin);

  const notes = str(d.notes, 1500);
  const people = tents.reduce((s, t) => s + t.guests.reduce((a, g) => a + cfg.guests[g], 0), 0);
  const body = [
    cfg.label,
    `${people} people in ${tents.length} ${cfg.unit}`,
    '',
    ...cfg.types.flatMap((type) => {
      const rows = tents.filter((t) => t.type === type);
      if (!rows.length) return [];
      return [`${type.toUpperCase()} ${cfg.unit.toUpperCase()}`, ...rows.map((t) => `  ${t.tent}: ${t.guests.join(' + ')}${t.beds ? ` (${t.beds})` : ''}`), ''];
    }),
    `Notes: ${notes || 'none'}`,
    '',
    `When: ${new Date().toISOString()}`,
  ].join('\n');

  const ok = await sendEmail(env, `Rooming ${wedding}: ${cfg.subject}`, body, cfg.replyTo);
  if (ok) return json({ ok: true }, 200, origin);
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

/**
 * Fire ONE realistic Klaviyo event to verify a specific Flow end-to-end.
 *
 *   node scripts/fire-test-event.js --metric=team_created --email=you@x.com --phone=+13145551234
 *
 * Unlike test-notifications.js (which fires every metric with placeholder text),
 * this sends a single event with a fully-built, on-brand cream payload so the
 * email + SMS that arrive look exactly like the real thing.
 */
'use strict';
const fs = require('fs'), path = require('path');

const env = {};
try {
  fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n').forEach(l => {
    const [k, ...v] = l.split('='); if (k && !k.startsWith('#')) env[k.trim()] = v.join('=').trim();
  });
} catch {}
const KEY = env.KLAVIYO_API_KEY || process.env.KLAVIYO_API_KEY || '';

const arg = (n) => { const h = process.argv.slice(2).find(a => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : null; };
const metric = arg('metric') || 'team_created';
const email  = arg('email');
const phone  = arg('phone');
if (!KEY)  { console.error('KLAVIYO_API_KEY not set'); process.exit(1); }
if (!email && !phone) { console.error('Need --email and/or --phone'); process.exit(1); }

// ── On-brand cream email shell (mirrors server.js emailShell/emailBox/emailBtn) ──
const btn = (href, label, sec) => `<a href="${href}" style="display:block;background:${sec?'#FBF9F4':'#1A1A1A'};color:${sec?'#1A1A1A':'#FBF9F4'};border:1px solid #1A1A1A;text-align:center;padding:15px 18px;border-radius:4px;font-weight:bold;font-size:13px;letter-spacing:0.06em;text-transform:uppercase;text-decoration:none;margin:0 0 12px;font-family:Helvetica,Arial,sans-serif">${label}</a>`;
const box = (label, value, note, mono) => `<div style="background:#ECE7DB;border-radius:6px;padding:20px;margin:0 0 14px;text-align:center"><div style="font-size:11px;font-weight:bold;letter-spacing:0.16em;text-transform:uppercase;color:#8A8479;margin:0 0 6px">${label}</div><div style="font-family:${mono?"'Courier New',monospace":"Georgia,serif"};font-size:24px;font-weight:bold;color:#1A1A1A;${mono?'letter-spacing:2px;':''}">${value}</div>${note?`<div style="font-size:13px;color:#5C5852;margin:8px 0 0">${note}</div>`:''}</div>`;
const shell = (eyebrow, heading, subhead, body) => `<div style="margin:0;padding:0;background:#F5F2EB;width:100%"><div style="font-family:Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 18px"><div style="text-align:center;margin:0 0 22px"><span style="font-family:Georgia,serif;font-size:22px;font-weight:bold;color:#1A1A1A">JORD <span style="font-style:italic;color:#B8884D">Golf</span></span></div><div style="background:#FBF9F4;border:1px solid #E4DDCE;border-radius:8px;padding:30px 26px"><div style="font-size:11px;font-weight:bold;letter-spacing:0.18em;text-transform:uppercase;color:#8A8479;margin:0 0 10px">${eyebrow}</div><h1 style="font-family:Georgia,serif;font-size:25px;font-weight:bold;color:#1A1A1A;line-height:1.25;margin:0 0 8px">${heading}</h1><p style="font-size:14px;color:#5C5852;margin:0 0 22px">${subhead}</p>${body}</div><p style="text-align:center;color:#8A8479;font-size:12px;margin:18px 0 0">JORD Golf &middot; <span style="font-style:italic">The new traditional</span><span style="color:#B8884D">*</span></p></div></div>`;

// ── Sample payloads per metric ──
const SAMPLES = {
  team_created: () => {
    const teamName = 'Bogey Brigade', shareCode = 'TEST42', eid = 'EVTDEMO';
    const joinUrl = 'https://tournament.jordgolf.com/register/' + eid + '?team=' + shareCode;
    const teamUrl = 'https://tournament.jordgolf.com/team/' + eid + '/' + shareCode;
    return {
      SmsText: `⛳ Shaheen, team "${teamName}" is created for the JORD Demo Classic! Teammates join with code ${shareCode} or this link: ${joinUrl}`,
      EmailSubject: `Team "${teamName}" is ready — invite your players`,
      EmailBodyHtml: shell('JORD Demo Classic',
        `Team <span style="font-style:italic;color:#B8884D">${teamName}</span> is set.`,
        'Now bring your teammates in.',
        box('Your Team', teamName)
        + box('Team Join Code', shareCode, 'Teammates enter this code — or scan your team QR — to join.', true)
        + `<p style="font-size:14px;color:#5C5852;line-height:1.6;margin:0 0 18px">Open your team page to see who's joined, share the invite link, and pull up the QR code.</p>`
        + btn(teamUrl, '👥 View Team Page &amp; Invite Players')),
    };
  },
};
const build = SAMPLES[metric];
if (!build) { console.error('No sample for metric:', metric, '— available:', Object.keys(SAMPLES).join(', ')); process.exit(1); }
const props = build();

(async () => {
  const fetch = global.fetch || require('node-fetch');
  const res = await fetch('https://a.klaviyo.com/api/events/', {
    method: 'POST',
    headers: { 'Authorization': `Klaviyo-API-Key ${KEY}`, 'Content-Type': 'application/json', 'revision': '2024-02-15' },
    body: JSON.stringify({ data: { type: 'event', attributes: {
      properties: { ...props, app: 'JORD Golf Tournament', test: true },
      metric:  { data: { type: 'metric',  attributes: { name: `jord_${metric}` } } },
      profile: { data: { type: 'profile', attributes: {
        email: email || undefined, phone_number: phone || undefined,
        first_name: 'Shaheen', last_name: 'Test',
      } } },
    } } }),
  });
  if (res.status >= 200 && res.status < 300) {
    console.log(`\n✓ jord_${metric} fired — HTTP ${res.status}`);
    console.log(`  email: ${email || '(none)'}   phone: ${phone || '(none)'}`);
    console.log(`  If the "JORD — Team Created" Flow is Live, the email + text should arrive within a minute.\n`);
  } else {
    console.log(`\n✗ HTTP ${res.status}`);
    console.log(await res.text().catch(() => ''));
    process.exit(1);
  }
})().catch(e => { console.error(e); process.exit(1); });

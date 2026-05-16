/**
 * JORD Golf — Notification connectivity test
 *
 * Verifies that messages can actually go OUT through both channels:
 *   • Klaviyo  — fires one sample event for every jord_* metric the server uses
 *   • SMTP     — sends one test email through the support@jordgolf.com mailbox
 *
 * It does NOT need the app server running — it reads .env and talks to
 * Klaviyo / the SMTP host directly, exactly the way server.js does.
 *
 *   node scripts/test-notifications.js --email=you@example.com --phone=+15551234567
 *
 * --email   where the SMTP test email + Klaviyo profile land   (required)
 * --phone   phone number for the Klaviyo SMS profile           (optional)
 * --klaviyo-only / --smtp-only   run just one channel
 *
 * A Klaviyo "✓ accepted" means the event reached Klaviyo. Whether a text/email
 * is actually delivered still depends on a matching Klaviyo *Flow* being Live
 * (see KLAVIYO-SETUP.md). SMTP "✓ sent" means the email left the building.
 */
'use strict';

const fs   = require('fs');
const path = require('path');

// ── Load .env the same way server.js does ──────────────────────────────────
const env = {};
try {
  fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n').forEach(line => {
    const [k, ...v] = line.split('=');
    if (k && !k.startsWith('#')) env[k.trim()] = v.join('=').trim();
  });
} catch { /* no .env — fall back to process.env */ }
const cfg = (k) => env[k] || process.env[k] || '';

const KLAVIYO_KEY = cfg('KLAVIYO_API_KEY');
const SMTP_HOST   = cfg('SMTP_HOST');
const SMTP_PORT   = parseInt(cfg('SMTP_PORT') || '587', 10);
const SMTP_USER   = cfg('SMTP_USER');
const SMTP_PASS   = cfg('SMTP_PASS');
const SUPPORT     = cfg('SUPPORT_EMAIL') || 'support@jordgolf.com';

// ── Args ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const argVal = (name) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : null;
};
const TEST_EMAIL = argVal('email');
const TEST_PHONE = argVal('phone');
const klaviyoOnly = args.includes('--klaviyo-only');
const smtpOnly    = args.includes('--smtp-only');

if (!TEST_EMAIL && !smtpOnly && !klaviyoOnly) {
  console.error('\n  Usage: node scripts/test-notifications.js --email=you@example.com [--phone=+15551234567]\n');
  process.exit(1);
}

// Every metric the server fires via sendKlaviyo(type, ...). Keep in sync with server.js.
const KLAVIYO_METRICS = [
  'registered', 'team_created', 'ball_scanned', 'tournament_ended',
  'dethroned', 'admin_welcome', 'admin_assigned', 'tournament_signup',
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const C = { ok: '\x1b[32m', bad: '\x1b[31m', dim: '\x1b[2m', warn: '\x1b[33m', reset: '\x1b[0m' };
const tag = (good) => good ? `${C.ok}✓${C.reset}` : `${C.bad}✗${C.reset}`;

async function testKlaviyo() {
  console.log(`\n${C.dim}── Klaviyo ──────────────────────────────────────────${C.reset}`);
  if (!KLAVIYO_KEY) {
    console.log(`${tag(false)} KLAVIYO_API_KEY is not set — Klaviyo events cannot fire.`);
    return { channel: 'Klaviyo', configured: false, passed: 0, total: 0 };
  }
  console.log(`${C.dim}Key: ${KLAVIYO_KEY.slice(0, 8)}…  ·  test profile: ${TEST_EMAIL || '(none)'}${C.reset}`);

  const fetch = global.fetch || require('node-fetch');
  let passed = 0;
  for (const metric of KLAVIYO_METRICS) {
    try {
      const res = await fetch('https://a.klaviyo.com/api/events/', {
        method: 'POST',
        headers: {
          'Authorization': `Klaviyo-API-Key ${KLAVIYO_KEY}`,
          'Content-Type': 'application/json',
          'revision': '2024-02-15',
        },
        body: JSON.stringify({ data: { type: 'event', attributes: {
          properties: { app: 'JORD Golf Tournament', test: true, SmsText: `[TEST] jord_${metric}`,
                        EmailSubject: `[TEST] jord_${metric}` },
          metric:  { data: { type: 'metric',  attributes: { name: `jord_${metric}` } } },
          profile: { data: { type: 'profile', attributes: {
            email: TEST_EMAIL || undefined,
            phone_number: TEST_PHONE || undefined,
            first_name: 'JORD', last_name: 'Test',
          } } },
        } } }),
      });
      const good = res.status >= 200 && res.status < 300;
      if (good) passed++;
      console.log(`  ${tag(good)} jord_${metric.padEnd(20)} ${C.dim}HTTP ${res.status}${C.reset}`);
      if (!good) {
        const body = await res.text().catch(() => '');
        console.log(`     ${C.bad}${body.slice(0, 200)}${C.reset}`);
      }
    } catch (e) {
      console.log(`  ${tag(false)} jord_${metric.padEnd(20)} ${C.bad}${e.message}${C.reset}`);
    }
    await sleep(150); // be gentle on the API
  }
  return { channel: 'Klaviyo', configured: true, passed, total: KLAVIYO_METRICS.length };
}

async function testSmtp() {
  console.log(`\n${C.dim}── SMTP (support@jordgolf.com) ──────────────────────${C.reset}`);
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.log(`${tag(false)} SMTP not configured — missing:`,
      [['SMTP_HOST', SMTP_HOST], ['SMTP_USER', SMTP_USER], ['SMTP_PASS', SMTP_PASS]]
        .filter(([, v]) => !v).map(([k]) => k).join(', '));
    console.log(`   ${C.warn}Password-reset, welcome, and signup emails will NOT send until these are set.${C.reset}`);
    return { channel: 'SMTP', configured: false, passed: 0, total: 1 };
  }
  console.log(`${C.dim}Host: ${SMTP_HOST}:${SMTP_PORT}  ·  user: ${SMTP_USER}${C.reset}`);

  let nodemailer;
  try { nodemailer = require('nodemailer'); }
  catch { console.log(`${tag(false)} nodemailer not installed`); return { channel: 'SMTP', configured: true, passed: 0, total: 1 }; }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  try {
    await transporter.verify();
    console.log(`  ${tag(true)} SMTP connection + login verified`);
  } catch (e) {
    console.log(`  ${tag(false)} SMTP verify failed: ${C.bad}${e.message}${C.reset}`);
    return { channel: 'SMTP', configured: true, passed: 0, total: 1 };
  }

  const to = TEST_EMAIL || SUPPORT;
  try {
    const info = await transporter.sendMail({
      from: SMTP_USER, to,
      subject: '[TEST] JORD Golf notification check',
      html: '<div style="font-family:Helvetica,Arial,sans-serif;background:#F5F2EB;padding:24px">'
          + '<div style="max-width:480px;margin:0 auto;background:#FBF9F4;border:1px solid #E4DDCE;border-radius:8px;padding:26px">'
          + '<h1 style="font-family:Georgia,serif;color:#1A1A1A;font-size:22px;margin:0 0 8px">SMTP is working ✓</h1>'
          + '<p style="color:#5C5852;font-size:14px;margin:0">If you can read this, JORD Golf can send transactional '
          + 'email (password resets, welcome emails, signup replies) from support@jordgolf.com.</p></div></div>',
    });
    console.log(`  ${tag(true)} Test email sent to ${to}  ${C.dim}(id ${info.messageId})${C.reset}`);
    return { channel: 'SMTP', configured: true, passed: 1, total: 1 };
  } catch (e) {
    console.log(`  ${tag(false)} sendMail failed: ${C.bad}${e.message}${C.reset}`);
    return { channel: 'SMTP', configured: true, passed: 0, total: 1 };
  }
}

(async () => {
  console.log(`\n${C.dim}━━━ JORD Golf — Notification connectivity test ━━━${C.reset}`);
  const results = [];
  if (!smtpOnly)    results.push(await testKlaviyo());
  if (!klaviyoOnly) results.push(await testSmtp());

  console.log(`\n${C.dim}── Summary ──────────────────────────────────────────${C.reset}`);
  let allGood = true;
  for (const r of results) {
    if (!r.configured) { allGood = false; console.log(`  ${tag(false)} ${r.channel}: not configured`); continue; }
    const good = r.passed === r.total;
    if (!good) allGood = false;
    console.log(`  ${tag(good)} ${r.channel}: ${r.passed}/${r.total} passed`);
  }
  console.log(`\n${C.dim}Klaviyo "accepted" only means the event reached Klaviyo. A text/email is`);
  console.log(`delivered only if a matching Live Flow exists — see KLAVIYO-SETUP.md.${C.reset}\n`);
  process.exit(allGood ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });

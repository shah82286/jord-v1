# JORD Golf — Klaviyo & Email Setup

How notifications work, what's connected, and the exact steps to finish wiring it up.

---

## How it works (the short version)

JORD has **two send channels**:

| Channel | Used for | Configured by |
|---|---|---|
| **Klaviyo** | Player messages — registration, shot results, "dethroned", tournament-ended, team-created. Email **and** SMS. | `KLAVIYO_API_KEY` env var ✅ already set |
| **SMTP** (support@jordgolf.com) | Staff/account email — password resets, admin/rep welcome, the `/signup` auto-reply, the "new signup" notice to the team. Email only. | `SMTP_*` env vars ❌ **not set yet** |

The JORD server **builds the full email HTML itself** (the cream-branded design) and hands it to whichever channel sends it. So you never design templates inside Klaviyo — you just build a **Flow** that drops the server's HTML into an email block.

---

## Part 1 — Klaviyo Flows

The server fires a Klaviyo **event** (called a "metric") every time something happens. A metric on its own does nothing — you need a **Flow** in Klaviyo that listens for it and sends the message.

### Metrics the server fires

| Metric name | When it fires | Has SMS? | Flow exists? |
|---|---|---|---|
| `jord_registered` | A player's team is finalized | Yes | ✅ Live |
| `jord_ball_scanned` | A player submits a shot | Yes | ✅ Live |
| `jord_tournament_ended` | Admin ends the tournament | Yes | ✅ Live |
| `jord_dethroned` | A team loses the #1 spot | Yes | ✅ Live |
| `jord_team_created` | Player 1 creates a team | Yes | ⬜ **build this** |
| `jord_admin_welcome` | A new admin account is created | No (email only) | ⬜ optional |
| `jord_admin_assigned` | An existing admin is added to an event | No (email only) | ⬜ optional |
| `jord_tournament_signup` | Someone submits the public `/signup` form | No (email only) | ⬜ optional |

The first four already work. The rest below are new.

### How to build a Flow (do this for `jord_team_created` first)

1. Klaviyo dashboard → **Flows** → **Create Flow** → **Create from scratch**.
2. Name it `JORD — Team Created`.
3. **Trigger**: choose **Metric** → pick `jord_team_created`.
   *(If it's not in the list yet, fire a test first — see Part 3 — then it appears.)*
4. Drag in an **Email** action. In the email's content, use a single HTML block containing exactly:
   ```
   {{ event.EmailBodyHtml|safe }}
   ```
   The `|safe` filter is **required** — without it Klaviyo escapes the HTML and the player sees raw code.
5. Set the email **Subject line** to:
   ```
   {{ event.EmailSubject }}
   ```
6. (Optional) Drag in an **SMS** action. Set its content to:
   ```
   {{ event.SmsText }}
   ```
7. Flow settings: **Allow re-entry** ON, **Smart Sending** OFF, mark the email/SMS **Transactional** (so it sends regardless of marketing opt-in).
8. Set the Flow **Live**.

Repeat for `jord_admin_welcome`, `jord_admin_assigned`, `jord_tournament_signup` if you want those to go through Klaviyo — but those also send via SMTP (Part 2), so they're optional. They have **no** `SmsText`, so don't add an SMS action to those.

---

## Part 2 — SMTP for support@jordgolf.com

Password-reset, welcome, and signup emails send through SMTP, **not** Klaviyo. Right now `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` are empty, so **those emails silently don't send.**

### To turn it on

1. Get SMTP credentials for `support@jordgolf.com` from your email provider:
   - **Google Workspace**: host `smtp.gmail.com`, port `587`, user `support@jordgolf.com`, password = an **App Password** (Google Account → Security → App Passwords — *not* the normal login password).
   - **Other host**: use their SMTP host / port / username / password.
2. In **Railway** → your service → **Variables**, set:
   ```
   SMTP_HOST = smtp.gmail.com
   SMTP_PORT = 587
   SMTP_USER = support@jordgolf.com
   SMTP_PASS = <the app password>
   ```
3. Railway redeploys automatically. Done — SMTP emails now send.

### Deliverability (so they don't land in spam)
Add these DNS records for `jordgolf.com` (your domain registrar / DNS host):
- **SPF** — a TXT record authorizing your mail host to send.
- **DKIM** — a key your mail provider gives you, added as a TXT/CNAME record.
- **DMARC** — a TXT record at `_dmarc.jordgolf.com`, e.g. `v=DMARC1; p=none; rua=mailto:support@jordgolf.com`.
Your email provider has a one-click guide for all three. Skipping this = reset emails land in spam.

---

## Part 3 — Test it

A standalone test script fires a sample of every Klaviyo metric and sends one SMTP test email. It reads `.env` and talks to Klaviyo / SMTP directly — the app server does **not** need to be running.

```
node scripts/test-notifications.js --email=you@example.com --phone=+15551234567
```

- `--email` — where the SMTP test email lands + the Klaviyo test profile (required)
- `--phone` — phone for the Klaviyo SMS test profile (optional)
- `--klaviyo-only` / `--smtp-only` — run just one channel

**Reading the result:**
- Klaviyo `✓ accepted` = the event reached Klaviyo. Watch it land under that profile's Activity in the Klaviyo dashboard. Whether a text/email is *delivered* still depends on a Live Flow (Part 1).
- SMTP `✓ sent` = the email left the server. Check the inbox.
- `✗ not configured` = the env vars aren't set yet.

After building each Flow, do a real end-to-end check: register a test team, confirm the email + text arrive.

---

## Quick status

- ✅ Klaviyo API key + list IDs set — events fire
- ✅ 4 player Flows Live (`registered`, `ball_scanned`, `tournament_ended`, `dethroned`)
- ✅ All email HTML re-skinned to the cream brand (built server-side)
- ⬜ Build Flow for `jord_team_created` (+ optional admin/signup flows)
- ⬜ Set `SMTP_*` env vars in Railway so reset/welcome/signup emails send
- ⬜ Add SPF / DKIM / DMARC DNS records

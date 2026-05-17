# JORD Golf — Klaviyo & Email Setup

How notifications work, what's connected, and the flows still to build.

---

## How it works (the short version)

**Everything sends through Klaviyo** — player messages *and* account/staff email.
Klaviyo sends over HTTPS, which Railway allows. (Raw SMTP was tried and dropped:
Railway blocks outbound SMTP ports, so every SMTP send timed out.)

The JORD server **builds the full email HTML itself** (the cream-branded design)
and passes it to Klaviyo as event data. You never design templates inside
Klaviyo — each Flow just drops the server's HTML into an email block via
`{{ event.EmailBodyHtml|safe }}`.

`KLAVIYO_API_KEY` + the list IDs are set ✅. The `SMTP_*` env vars are unused —
leave them empty.

---

## Part 1 — Klaviyo Flows

The server fires a Klaviyo **event** (a "metric") when something happens. A metric
on its own does nothing — you need a **Flow** that listens for it and sends the
message.

### Metrics the server fires

| Metric | Fires when | SMS? | Flow |
|---|---|---|---|
| `jord_registered` | A player's team is finalized | Yes | ✅ Live |
| `jord_ball_scanned` | A player submits a shot | Yes | ✅ Live |
| `jord_tournament_ended` | Admin ends the tournament | Yes | ✅ Live |
| `jord_dethroned` | A team loses the #1 spot | Yes | ✅ Live |
| `jord_team_created` | Player 1 creates a team | Yes | ✅ Live |
| `jord_password_reset` | Admin/rep requests a password reset | No | ⬜ **build — important** |
| `jord_account_welcome` | A new rep account is created | No | ⬜ build |
| `jord_admin_welcome` | A new admin account is created | No | ⬜ build |
| `jord_admin_assigned` | An existing admin is added to an event | No | ⬜ build |
| `jord_tournament_signup` | Someone submits the public `/signup` form | No | ⬜ build |

The top five are done. The bottom five still need Flows — **`jord_password_reset`
first**, since without it nobody can reset a password.

### How to build a Flow

1. Klaviyo → **Flows** → **Create Flow** → **Create from scratch**.
2. Name it (e.g. `JORD — Password Reset`).
3. **Trigger**: **Metric** → pick the `jord_*` metric.
   *(Not in the list? Fire a test — Part 3 — then it appears.)*
4. Drag in an **Email** action → edit content → one **HTML block** containing exactly:
   ```
   {{ event.EmailBodyHtml|safe }}
   ```
   The `|safe` is **required** — without it the recipient sees raw HTML code.
5. Email **Subject line**:
   ```
   {{ event.EmailSubject }}
   ```
6. **Only for metrics with SMS = Yes** — drag in an **SMS** action, content:
   ```
   {{ event.SmsText }}
   ```
   The five "No SMS" metrics have no `SmsText` — don't add an SMS action to those.
7. Settings: **Smart Sending OFF**, **Transactional ON** (both the email and SMS
   blocks), flow-level **Allow re-entry ON**.
8. Set the Flow **Live**.

⚠️ **Transactional matters.** Password resets, welcome emails, etc. must reach
people who never opted into marketing. Marking the message **Transactional** is
what allows that. Klaviyo reviews transactional status once per account — if it
shows "Under Review," it must be approved before these send. Confirm your 4
original flows still show Transactional **Approved** too.

---

## Part 2 — Test it

A standalone script fires a sample of every Klaviyo metric. It reads `.env` and
talks to Klaviyo directly — the app server does **not** need to be running.

```
node scripts/test-notifications.js --email=you@example.com --phone=+15551234567
```
Fires all metrics. `--klaviyo-only` skips the (unused) SMTP check.

To verify **one** flow end-to-end with a realistic payload:
```
node scripts/fire-test-event.js --metric=team_created --email=you@x.com --phone=+13145551234
```

**Reading it:** Klaviyo `✓ accepted` (HTTP 202) means the event reached Klaviyo —
watch it under that profile's Activity feed. Whether an email/text is *delivered*
still depends on a Live, Transactional Flow.

After building a flow, do a real end-to-end check (register a test team, request
a password reset, etc.) and confirm the message arrives.

---

## Receiving email at support@jordgolf.com

Sending is handled by Klaviyo. **Receiving** replies at support@jordgolf.com is
separate — keep that mailbox/alias in Google Workspace as normal. Klaviyo emails
can be set with a reply-to of support@jordgolf.com in the flow's email settings
so replies land there.

---

## Quick status

- ✅ Klaviyo API key + list IDs set — events fire (8/8 in the connectivity test)
- ✅ 5 Flows Live: `registered`, `ball_scanned`, `tournament_ended`, `dethroned`, `team_created`
- ✅ All email HTML re-skinned to the cream brand (built server-side)
- ✅ All transactional email routed through Klaviyo (SMTP dropped — Railway blocks it)
- ⬜ Build Flow: `jord_password_reset` (do first), `jord_account_welcome`, `jord_admin_welcome`, `jord_admin_assigned`, `jord_tournament_signup`
- ⬜ Confirm Klaviyo transactional status is **Approved** (not "Under Review")

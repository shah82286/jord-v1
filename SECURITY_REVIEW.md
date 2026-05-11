# JORD Golf Tournament System - Security Review
**Date:** May 7, 2026  
**Reviewer:** Claude (Opus 4.7)  
**Status:** Critical Issues Found

---

## Executive Summary

The JORD Golf system has **4 critical security vulnerabilities** and **7 moderate/low issues** that need immediate attention. The most urgent is exposed API keys in the `.env` file. Overall, the application has a solid foundation with parameterized SQL queries and reasonable auth patterns, but frontend data handling and secrets management need fixes.

---

## 🔴 CRITICAL ISSUES

### 1. **Exposed API Keys in `.env` File**
**Severity:** CRITICAL  
**Location:** `.env` file (committed to git history or visible in deployment)

**Issue:** real production keys for Mapbox, Anthropic, and Klaviyo were present in `.env` at the time of this review (values redacted from this report — see local `.env` and rotate before any push).

```
MAPBOX_TOKEN=<REDACTED — see .env>
ANTHROPIC_API_KEY=<REDACTED — see .env>
KLAVIYO_API_KEY=<REDACTED — see .env>
```

**Risks:**
- Any attacker with these keys can:
  - Access Mapbox API (impersonate your app, use your quota)
  - Call Anthropic API (expensive, data exposure)
  - Manipulate Klaviyo email/SMS campaigns
  - If `.env` is in git history, the keys are permanently compromised

**Fix (Immediate):**
1. **Rotate all keys immediately:**
   - Mapbox: invalidate token, create new one at mapbox.com
   - Anthropic: delete key at console.anthropic.com, create new one
   - Klaviyo: regenerate API key

2. **Remove from git history:**
   ```bash
   git filter-branch --force --index-filter \
     'git rm --cached --ignore-unmatch .env' \
     --prune-empty --tag-name-filter cat -- --all
   git push origin --force --all
   ```

3. **Use environment variables instead:**
   - In Railway/production: set secrets in platform UI (not in files)
   - In development: never commit `.env`, use `.env.local` (gitignored)
   - Never reference files in code: use `process.env.KEY` only

4. **Verify `.env` is in `.gitignore`:**
   ```bash
   cat .gitignore  # should have .env
   ```

---

### 2. **Stored XSS via Player Names in Leaderboard**
**Severity:** CRITICAL  
**Location:** `public/leaderboard.html:631`, `public/leaderboard.html:646`, similar patterns across all HTML files

**Issue:**
Player names, team names, and drop codes are inserted directly into `innerHTML` without escaping:

```javascript
// VULNERABLE CODE in leaderboard.html
br.innerHTML = '<span class="lb-ball-name">' + (b.player_name || b.drop_code) + '</span>'
```

If a player registers with name `<img src=x onerror="alert('XSS')">`, the JavaScript executes in the browser.

**Attack Scenario:**
1. Attacker registers a player with name: `<script>fetch('/api/admin/...', {method:'POST',...})</script>`
2. Script executes when leaderboard loads, steals session tokens or modifies scores

**Fix (Required):**
Replace all `innerHTML` assignments with `.textContent` for user-supplied data, or use proper escaping:

```javascript
// SAFE: Use textContent for plain text
br.innerHTML = '<span class="lb-ball-name"></span>';
br.querySelector('.lb-ball-name').textContent = b.player_name || b.drop_code;

// OR: Escape HTML
function escapeHtml(text) {
  const map = {
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}
br.innerHTML = '<span class="lb-ball-name">' + escapeHtml(b.player_name || b.drop_code) + '</span>';
```

**Affected Files:** All HTML files (admin.html, dashboard.html, leaderboard.html, monitor.html, register.html, scan.html, test.html)

---

### 3. **Weak Admin Password Default**
**Severity:** CRITICAL  
**Location:** `server.js:27`

**Issue:**
```javascript
const ADMIN_PASSWORD = env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || 'jord2026';
```

The default password `jord2026` is:
- Easy to guess (contains year, brand name)
- Hard-coded in source
- Used to seed the super admin account on first run
- Not rotated between deployments

**Attack:**
If anyone has access to source code or knows it's a JORD app, they can try `jord2026` to access admin.

**Fix (Required):**
1. **Change the default immediately:**
   ```bash
   # Generate a strong random password
   node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
   # Set in .env
   # ADMIN_PASSWORD=a1f3d9e2b4c6f8a0
   ```

2. **Remove the hardcoded default:**
   ```javascript
   const ADMIN_PASSWORD = env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD;
   if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD env var is required');
   ```

3. **On first deploy:**
   - Generate unique password per deployment
   - Store only in platform secrets (Railway, etc.)
   - Force super admin to change password on first login

---

### 4. **No Rate Limiting on Critical Endpoints**
**Severity:** CRITICAL  
**Location:** `server.js:1354` (scan endpoints), `server.js:1235` (registration)

**Issue:**
The scan and registration endpoints have **no rate limiting**:
```javascript
app.post('/api/scan/ld/:code', (req, res) => {  // NO RATE LIMIT
app.post('/api/events/:eventId/register-player', (req, res) => {  // NO RATE LIMIT
```

**Attacks:**
1. **Brute-force drop codes:** Attacker scans `/api/scan/ld/{code}` with sequential codes to find valid ones
2. **Spam registration:** Register thousands of fake players
3. **Denial of Service:** Flood with requests to crash the server or database

**Fix (Required):**
```javascript
// Add rate limiters for public endpoints
const scanLimiter = rateLimit({ max: 20, windowMs: 60 * 1000, message: 'Too many scans. Wait 1 minute.' });
const registerLimiter = rateLimit({ max: 10, windowMs: 60 * 1000, message: 'Too many registration attempts.' });

app.post('/api/scan/ld/:code', scanLimiter, (req, res) => { ... });
app.post('/api/scan/cp/:code', scanLimiter, (req, res) => { ... });
app.post('/api/events/:eventId/register-player', registerLimiter, (req, res) => { ... });
```

Note: Current in-memory rate limiter is acceptable for single-instance apps, but will reset on server restart. For multi-instance deployments (Railway, etc.), move to Redis.

---

## 🟡 MODERATE ISSUES

### 5. **No CSRF Protection**
**Severity:** MODERATE  
**Location:** All POST/PUT/DELETE endpoints

**Issue:**
Admin endpoints have no CSRF token validation. A malicious website could trick an admin into making unintended changes:

```javascript
// Attacker's site:
<img src="https://yourapp.com/api/events/123/end" />
// If admin visits attacker's site while logged in, event ends!
```

**Why it's moderate (not critical):**
- Requires admin to be logged in and visit attacker's site
- Token-based auth makes cross-origin attacks slightly harder
- But still a real vulnerability

**Fix:**
Use CSRF token middleware:
```javascript
const csrf = require('csurf');
const session = require('express-session');

app.use(session({ secret: 'your-secret', resave: false, saveUninitialized: true }));
app.use(csrf({ cookie: false })); // Use session-based tokens

// On POST/admin endpoints:
app.post('/api/admin/...', requireAuth, (req, res) => {
  // Token automatically validated by middleware
  ...
});
```

Or simpler: Require token in request header (already done for auth):
```javascript
// Client must send X-CSRF-Token header on POST
// Verify it matches session or is a known value
```

---

### 6. **Insufficient Input Validation**
**Severity:** MODERATE  
**Location:** `server.js:1236`, `server.js:1272` (registration, team finalization)

**Issue:**
User inputs are trimmed but not validated for length or content:
```javascript
db.prepare(...).run(first_name.trim(), last_name.trim(), ...)
// No max length checks, no character validation
```

**Risks:**
- Very long names can cause display issues
- Special characters might break formatting
- Database column lengths not enforced in app layer

**Fix:**
```javascript
function validateName(name) {
  if (!name || typeof name !== 'string') return false;
  if (name.trim().length < 1 || name.trim().length > 50) return false;
  return /^[a-zA-Z\s'-]+$/.test(name); // alphanumeric, spaces, hyphens, apostrophes
}

if (!validateName(first_name) || !validateName(last_name)) {
  return res.status(400).json({ error: 'Invalid name format' });
}
```

---

### 7. **Weak Session Timeout**
**Severity:** MODERATE  
**Location:** `server.js:239`

**Issue:**
```javascript
const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
// Sessions last 7 days
```

7 days is long. If a device is stolen or compromised, attacker has a week of access.

**Fix:**
```javascript
// Shorter session timeout
const SESSION_TIMEOUT = 24 * 60 * 60 * 1000; // 24 hours
const expires = new Date(Date.now() + SESSION_TIMEOUT).toISOString();

// Optional: Add refresh token mechanism for longer sessions
```

---

### 8. **No HTTPS Enforcement**
**Severity:** MODERATE  
**Location:** Entire app

**Issue:**
The app doesn't enforce HTTPS. If deployed to public internet:
- Session tokens can be intercepted
- Credentials can be stolen
- Data-in-transit is unencrypted

**Fix:**
In production (Railway, etc.), enable HTTPS at the platform level. In Express:
```javascript
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && req.header('x-forwarded-proto') !== 'https') {
    return res.redirect(301, `https://${req.header('host')}${req.url}`);
  }
  next();
});
```

---

### 9. **Missing Security Headers**
**Severity:** MODERATE  
**Location:** `server.js`

**Issue:**
No security headers like CSP, X-Frame-Options, X-Content-Type-Options:
```javascript
// Add to server.js
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});
```

---

### 10. **Database File Permissions**
**Severity:** MODERATE  
**Location:** `./data/jord.db`

**Issue:**
SQLite database file permissions may be readable by other users on shared servers:
```bash
ls -la data/  # Check file permissions
```

**Fix:**
Restrict database file access:
```javascript
fs.mkdirSync('./data', { mode: 0o700 });  // rwx------
```

---

## 🟢 LOW ISSUES

### 11. **No Helmet.js**
Use helmet for automatic security headers:
```bash
npm install helmet
```
```javascript
const helmet = require('helmet');
app.use(helmet());
```

### 12. **Anthropic API Key Not Validated**
The Anthropic API key is loaded but appears unused. If it's not needed, remove it.

### 13. **Console Logs in Production**
Remove or conditionally log sensitive data (passwords, tokens, emails).

---

## ✅ WHAT'S DONE WELL

1. **SQL Injection Protection:** All queries use parameterized statements (`?` placeholders) with better-sqlite3 — this is correct and prevents SQL injection.

2. **Password Hashing:** Using `crypto.scryptSync` with salt is secure for admin passwords.

3. **Session Management:** Session tokens are 64-character random hex, good entropy.

4. **Auth Middleware:** `requireAuth`, `requireSuper`, `requirePerm` patterns are clean and applied correctly to sensitive endpoints.

5. **Public Endpoints Use Code Validation:** Drop codes and event IDs are treated as secrets, not sequential IDs — reasonable access control for public features.

6. **Foreign Key Constraints:** Database schema enforces referential integrity.

7. **CORS Enabled:** CORS is configured (though `origin: '*'` is permissive but acceptable for a public app).

---

## Priority Fix Timeline

**IMMEDIATE (Today):**
1. Rotate all API keys
2. Remove `.env` from git history
3. Fix XSS vulnerabilities with textContent
4. Change/randomize admin password default

**THIS WEEK:**
5. Add rate limiting to scan & registration endpoints
6. Add input validation to registration
7. Shorten session timeout

**BEFORE PRODUCTION:**
8. Enforce HTTPS
9. Add security headers
10. Add helmet.js
11. Set database file permissions
12. Security audit of Klaviyo integration

---

## Testing Checklist

- [ ] Try XSS payload in player name registration: `<img src=x onerror=alert('xss')>`
- [ ] Verify no script executes on leaderboard
- [ ] Try brute-forcing drop codes: loop through `/api/scan/ld/{CODE}`
- [ ] Verify rate limiter blocks after N attempts
- [ ] Check `.env` is not in git: `git ls-files | grep .env`
- [ ] Verify `process.env.ADMIN_PASSWORD` is set before accessing DB
- [ ] Test session expiration after 24 hours
- [ ] Verify HTTPS redirect in production

---

## Recommendations for Architecture

1. **Secrets Management:**
   - Remove all hardcoded secrets
   - Use Railway/platform UI for environment variables
   - Never commit `.env`

2. **Frontend Security:**
   - Use a template library (Handlebars, EJS) instead of string concatenation
   - Or use textContent + createElement for all user data
   - Add Content Security Policy (CSP) header

3. **Deployment:**
   - Enable HTTPS enforcement at platform level
   - Use environment-specific configs
   - Run security headers middleware

4. **Testing:**
   - Add integration tests for auth flow
   - Test with invalid/malicious inputs
   - Regularly rotate API keys (quarterly)

---

## Questions for Clarification

1. Is this running on Railway/public internet or local/private network?
2. How many concurrent admins typically use this?
3. Is the Anthropic API key actually used? (I didn't see it in the code)
4. Do you have a backup strategy for the SQLite database?


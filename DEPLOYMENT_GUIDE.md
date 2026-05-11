# JORD Golf - Production Deployment Guide
**Last Updated:** May 8, 2026

Quick step-by-step guide to deploy JORD Golf to production safely.

---

## Phase 1: Preparation (Do First)

### Step 1: Rotate All API Keys

#### Mapbox
1. Go to https://account.mapbox.com/access-tokens/
2. Find your old token (the one currently set in your local `.env` — do not paste it here)
3. Click the token → "Delete Token"
4. Click "Create a token"
5. Name: "JORD Golf Production"
6. Scopes: Check "MAPS:READ"
7. Resources: Add your production domain (e.g., `jord.example.com`)
8. Click "Create token"
9. Copy the new token starting with `pk.eyJ...`

#### Anthropic
1. Go to https://console.anthropic.com/account/api-keys
2. Find your old key: `sk-ant-api03-...` (from `.env`)
3. Click the trash icon to delete
4. Click "Create Key"
5. Name: "JORD Golf Production"
6. Copy the new key

#### Klaviyo
1. Go to https://www.klaviyo.com/settings/account/api-keys
2. Find your old private key
3. Click "Delete" or "Deactivate"
4. Click "Create API Key"
5. Select "Private API Key"
6. Copy the new key

### Step 2: Create Production Environment File

On your **production server** (not checked into git):

```bash
# SSH into server
ssh user@your-production-server.com

# Navigate to app directory
cd /path/to/jord

# Create .env from template
cp .env.example .env

# Edit with your values
nano .env
```

Fill in `.env` with:
```
PORT=3000
APP_URL=https://your-domain.com    # Use HTTPS!
NODE_ENV=production
ADMIN_PASSWORD=<generate strong random password - 32+ characters>

MAPBOX_TOKEN=<new token from step 1>
ANTHROPIC_API_KEY=<new key from step 1>
KLAVIYO_API_KEY=<new key from step 1>
KLAVIYO_EMAIL_LIST_ID=WPqhxT
KLAVIYO_SMS_LIST_ID=TAg3Zd
SUPER_ADMIN_EMAIL=admin@your-domain.com
```

### Step 3: Generate Strong Admin Password

```bash
# On your Mac/Linux/WSL:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Copy the output and paste into .env as ADMIN_PASSWORD
```

---

## Phase 2: Deployment to Production

### Option A: Railway (Recommended)

1. **Push code to GitHub:**
   ```bash
   git add -A
   git commit -m "feat: security hardening and fixes"
   git push origin main
   ```

2. **Connect on Railway.app:**
   - Go to https://railway.app
   - Create new project → Import from GitHub
   - Select your repo
   - Railway auto-detects Node.js + creates database

3. **Set Environment Variables:**
   - Go to Project → Variables
   - Add all from your `.env`:
     ```
     PORT=3000
     NODE_ENV=production
     APP_URL=https://your-railway-url.railway.app
     ADMIN_PASSWORD=<your generated password>
     MAPBOX_TOKEN=<new token>
     ANTHROPIC_API_KEY=<new key>
     KLAVIYO_API_KEY=<new key>
     KLAVIYO_EMAIL_LIST_ID=WPqhxT
     KLAVIYO_SMS_LIST_ID=TAg3Zd
     SUPER_ADMIN_EMAIL=admin@your-domain.com
     ```
   - **IMPORTANT:** Do NOT add these to `.env` file on Git!

4. **Deploy:**
   - Click "Deploy" button
   - Watch logs: `npm start`
   - Should see: `[Auth] Super admin created: admin@your-domain.com`

5. **Enable HTTPS:**
   - Go to Settings → Domain
   - Add your custom domain
   - Railway auto-generates SSL certificate

6. **Test:**
   ```bash
   curl https://your-domain.com/api/server-info
   # Should return: {"localIP":"...","port":"3000",...}
   ```

---

### Option B: Heroku

1. **Install Heroku CLI:**
   ```bash
   npm install -g heroku
   heroku login
   ```

2. **Create Heroku app:**
   ```bash
   heroku create your-app-name
   ```

3. **Set environment variables:**
   ```bash
   heroku config:set NODE_ENV=production
   heroku config:set ADMIN_PASSWORD="your-generated-password"
   heroku config:set MAPBOX_TOKEN="your-new-token"
   heroku config:set ANTHROPIC_API_KEY="your-new-key"
   heroku config:set KLAVIYO_API_KEY="your-new-key"
   heroku config:set KLAVIYO_EMAIL_LIST_ID="WPqhxT"
   heroku config:set KLAVIYO_SMS_LIST_ID="TAg3Zd"
   ```

4. **Deploy:**
   ```bash
   git push heroku main
   ```

5. **View logs:**
   ```bash
   heroku logs --tail
   ```

6. **Open app:**
   ```bash
   heroku open
   ```

---

### Option C: AWS, Google Cloud, Azure, etc.

Contact your cloud provider for Node.js deployment. The process is similar:

1. Create a new Node.js application/instance
2. Set environment variables via platform UI (NOT in .env)
3. Point database to `data/jord.db` (SQLite file)
4. Enable SSL/HTTPS
5. Set `NODE_ENV=production`
6. Run: `npm install && npm start`

---

## Phase 3: Post-Deployment Verification

### Check 1: Security Headers

```bash
curl -I https://your-domain.com/api/server-info
```

Should see:
```
X-Content-Type-Options: nosniff
X-Frame-Options: SAMEORIGIN
X-XSS-Protection: 1; mode=block
Referrer-Policy: strict-origin-when-cross-origin
```

### Check 2: HTTPS Redirect

```bash
curl -I http://your-domain.com/api/server-info
```

Should redirect to `https://...` (301 or 302)

### Check 3: Rate Limiting

```bash
# Try scanning 40 times (limit is 30/min)
for i in {1..40}; do 
  curl -X POST https://your-domain.com/api/scan/ld/TEST001 \
    -H "Content-Type: application/json" \
    -d '{"lat":40.0,"lon":-105.0,"location_type":"fairway"}' \
    -s | grep -q "error" && echo "Limited at $i" && break
done
```

Should block around request 31.

### Check 4: First Admin Login

1. Open https://your-domain.com/admin
2. Email: `admin@your-domain.com` (from SUPER_ADMIN_EMAIL)
3. Password: The one you set in `ADMIN_PASSWORD`
4. Should log in successfully

### Check 5: Create Test Event

1. Click "New Event"
2. Fill in tournament details
3. Click "Create"
4. Should appear in list
5. Go to leaderboard and verify data

---

## Phase 4: Ongoing Operations

### Daily
- ✅ Monitor error logs for any issues
- ✅ Watch rate limiter for attack patterns

### Weekly
- ✅ Test admin login
- ✅ Verify backups are working

### Monthly
- ✅ Check for npm security updates: `npm audit`
- ✅ Update dependencies: `npm update`
- ✅ Review server logs for suspicious activity

### Quarterly
- ✅ Rotate API keys (Mapbox, Anthropic, Klaviyo)
- ✅ Rotate admin passwords
- ✅ Test database backup and restore

---

## Troubleshooting

### Problem: "Port 3000 already in use"
**Solution:** Change PORT in environment variables or kill process:
```bash
lsof -i :3000  # Find process
kill -9 <PID>  # Kill it
```

### Problem: "MAPBOX_TOKEN is missing"
**Solution:** Verify environment variable is set:
```bash
# On Railway/Heroku/etc:
heroku config  # or platform UI
# Should list MAPBOX_TOKEN=pk.eyJ...
```

### Problem: "Cannot connect to database"
**Solution:** Ensure `data/` directory exists and has write permissions:
```bash
mkdir -p data
chmod 700 data
```

### Problem: "Admin password not working"
**Solution:** Check what password was generated on server startup:
```bash
# View logs (platform-specific)
railway logs  # or heroku logs or platform UI
# Look for: "[Auth] Super admin created"
```

### Problem: "Leaderboard not updating"
**Solution:** Check browser console for SSE errors, verify SSL certificate is valid

---

## Database Backup

### Automatic (Recommended)

Use platform backup feature:
- **Railway:** Settings → Backups
- **Heroku:** Add-ons → PG Backups

### Manual Backup

```bash
# SSH into server
scp user@server:/path/to/data/jord.db ./backup-$(date +%Y%m%d).db

# Or if local:
cp data/jord.db backup-$(date +%Y%m%d).db
```

### Restore Backup

```bash
# Stop the server
# Copy old database:
cp data/jord.db data/jord.db.backup
# Restore from backup:
cp backup-20260501.db data/jord.db
# Start server
```

---

## Support

If something breaks:

1. Check logs for error messages
2. Verify all environment variables are set
3. Verify API keys are valid
4. Test with: `curl https://your-domain.com/api/server-info`
5. Review SECURITY_REVIEW.md for potential issues

---

## Security Reminders

⚠️ **CRITICAL:**
- Never commit `.env` to git
- Never log API keys in server logs
- Rotate keys quarterly
- Use HTTPS only in production
- Keep NODE_ENV=production

✅ **DONE (Already Fixed):**
- XSS protection enabled
- Rate limiting enabled
- Security headers enabled
- Input validation enabled
- Admin password hardened

---

**Good luck with your deployment! 🚀**

For detailed security information, see: SECURITY_FIXES_APPLIED.md  
For code review details, see: FUNCTIONALITY_AND_UX_REVIEW.md


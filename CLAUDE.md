# JORD Golf Tournament System

## Deployment & Testing
- Do NOT attempt to access live URLs - I will test on the live site myself and report back
- Before any `git push`, verify CHANGELOG.md and docs are up to date and ask if I want to review screenshots first
- For mobile testing, use local network IP (not localhost) - do not set up HTTPS/ngrok/self-signed certs unless explicitly asked

## Project Stack
- Maps: Mapbox - always verify layer order when adding/modifying zones (rough must render correctly)
- Email flows: Klaviyo - remember the `|safe` filter for HTML variables in all flow templates
- Fonts: Playfair Display + Inter (NOT Futura)
- Email-based registration flow (not SMS)
- Node version: check before assuming - better-sqlite3 has native module issues on Node v22

## Secrets & Git Hygiene
- NEVER commit real tokens, even in .env.example - use placeholder values like `pk.YOUR_TOKEN_HERE`
- Run `git diff --staged` and check for secrets before any commit

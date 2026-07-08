# Church Oceania Cell

Cloudflare Pages app for church cell and pastoral-care management.

This repository stores only application code and Cloudflare binding configuration. Do not commit real member photos, phone numbers, addresses, birth dates, family notes, visit notes, call summaries, spreadsheets, or PDF source files.

## Architecture

- Cloudflare Pages: web app hosting
- Pages Functions: API endpoints
- Cloudflare D1: members, visit notes, audit logs
- Cloudflare R2: member photos
- Cloudflare Access: admin-only login protection

## Local development

Static UI can be opened from `public/index.html`. For Pages Functions and bindings, use Wrangler.

```powershell
npm run dev
```

## Private local data

The local Oceania community data generated from the PDF, Excel, and DOCX sources is intentionally kept out of git:

- `public/member-details.private.js`
- `public/photos/`
- `scratch/oceania-private/`

Regenerate the private local data after changing source documents:

```powershell
python scripts/build_oceania_private_data.py
```

Verify the static local app after starting a local server for `public/`:

```powershell
python -m http.server 4173 --bind 127.0.0.1
node scripts/verify_local_app.mjs http://127.0.0.1:4173/
```

## Build settings for Cloudflare Pages

- Framework preset: None
- Build command: `exit 0` or empty
- Build output directory: `public`
- Production branch: `main`

## Pages bindings

D1/R2 bindings are managed through `wrangler.jsonc`, because this Pages project is configured to use Wrangler-managed bindings.

Required production bindings:

- D1 binding: variable name `DB`, database `church-oceania-cell-db`
- R2 binding: variable name `PHOTOS`, bucket `church-oceania-member-photos`

## Cloudflare resources

Create the resources:

```powershell
npx wrangler d1 create church-oceania-cell-db
npx wrangler r2 bucket create church-oceania-member-photos
```

Apply the schema migrations:

```powershell
npx wrangler d1 migrations apply church-oceania-cell-db --remote
```

Import the private D1 seed data generated from the local source documents:

```powershell
npx wrangler d1 execute church-oceania-cell-db --remote --file scratch/oceania-private/oceania-private-import.sql
```

For production, enable the login protection and set a strong site password/session secret. Use `CALL_NOTE_TOKEN` or `CALL_NOTE_WEBHOOK_TOKEN` only for the external Call Note webhook if you manage that token through Cloudflare environment variables.

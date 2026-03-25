# Mangelrapport

Mangelrapport is a small Cloudflare Pages app for tracking missing instruments in repair trays.

## What it does

- create, edit, and delete reports
- add missing instruments and photos
- show a live print preview
- persist data through Cloudflare Pages Functions and Turso

## Project structure

- `public/` — the browser app and static assets
- `functions/api/` — Cloudflare Pages Functions
- `wrangler.toml` — Pages configuration

## Local development

1. Install dependencies:

   ```bash
   npm install
   ```

2. Set the required environment variables for the Functions:

   - `TURSO_URL`
   - `TURSO_TOKEN`

3. Start the local Pages dev server:

   ```bash
   npm run dev
   ```

## Deployment

Deploy the `public/` directory as a Cloudflare Pages project and set the same Turso environment variables in Pages.

The main app shell lives in `public/mangel-rapport.html`.

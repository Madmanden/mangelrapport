# Mangelrapport

Mangelrapport is a browser-based app for tracking missing instruments in repair trays. It gives the team one shared overview of active reports, tray details, part numbers, and photos instead of relying on scattered notes, screenshots, and verbal updates.

**Case study:** [christianholmdev.dk/projects/mangelrapport](https://christianholmdev.dk/projects/mangelrapport/)

## Why it exists

When an instrument is missing from a repair tray, the information needs to stay visible to the small team handling those cases. Before Mangelrapport, that information was spread across notes, ad hoc screenshots, and hallway updates, making it easy for context to disappear between people or workstations.

Mangelrapport turns that workflow into one shared browser app where active reports can be created, updated, printed, and cleaned up consistently.

## How it is used

Staff work in a three-column desktop interface with the report list, editor, and live print preview visible together. Each report can contain multiple missing instruments with quantity, instrument number, and an optional pasted T-DOC screenshot.

Reports older than seven days are highlighted so aging cases stand out. Changes are stored centrally through Cloudflare Pages Functions and Turso, allowing multiple workstations to use the same shared overview. Reports that have not been updated for 60 days are removed automatically.

## Screenshot

![Mangelrapport screenshot](screenshot/screenshot.jpg)

## What it does

- create, edit, and delete reports
- add missing instruments and photos
- paste T-DOC screenshots directly into reports
- show a live print preview
- persist shared data through Cloudflare Pages Functions and Turso
- highlight reports when their report date is more than 7 days old
- automatically remove reports that have not been updated for 60 days
- warn when the current session has expired

The project grew out of a local-only prototype. You can still see the original single-file shape in `standalone/standalone.html`; the current version is a shared web app.

## Project structure

- `public/` — browser app and static assets
- `functions/api/` — Cloudflare Pages Functions
- `standalone/` — original local-only prototype
- `screenshot/` — app screenshot
- `wrangler.toml` — Cloudflare Pages configuration

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

# Sedifex — PWA + Firebase Starter

This repo is a drop-in starter for **Sedifex** (inventory & POS). It ships as a **website** that is also **installable as a PWA**, with **Firebase** (Auth + Firestore + Functions).

## What’s inside
- `web/` — React + Vite + TypeScript PWA
- `functions/` — Firebase Cloud Functions (Node 20) for store onboarding and stock receipts
- `firestore.rules` — Multi-tenant security rules scaffold
- `.github/workflows/` — Optional CI for deploying Functions (if you want to use GitHub Actions)

## Quick start (local dev)
1) Install Node 20+.
2) Go to `web/` and install deps:
   ```bash
   cd web
   npm i
   npm run dev
   ```
3) Create a Firebase project (e.g., `sedifex-dev`) and fill these env vars in `web/.env.local`:
   ```env
   VITE_FB_API_KEY=REPLACE_ME
   VITE_FB_AUTH_DOMAIN=sedifex-dev.firebaseapp.com
   VITE_FB_PROJECT_ID=sedifex-dev
   VITE_FB_STORAGE_BUCKET=sedifex-dev.appspot.com
   VITE_FB_APP_ID=REPLACE_ME
   ```
4) (Optional) Deploy Functions:
   ```bash
   cd functions
   npm i
   # Login to Firebase
   npx firebase login
   # Set your project
   npx firebase use sedifex-dev
   # Deploy
   npm run deploy
   ```

## Deploy the PWA (Vercel/Netlify/Firebase Hosting)
- Point your host to build from `web/` with build command `npm run build` and output dir `dist`.
- Add the env vars above to your hosting provider.
- Set your domain `app.sedifex.com` to the deployed frontend.

## Firebase setup notes
- Enable **Authentication → Phone** and **Email/Password** (optional).
- Enable **Firestore** and publish `firestore.rules`.
- Create a second project for production later (e.g., `sedifex-prod`).

### Workspace access spreadsheet
- The onboarding Google Sheet should include workspace metadata columns such as `contractStart`, `contractEnd`, `paymentStatus`, `amountPaid`, and `company` for each store row.
- Date columns can be provided as ISO-like strings (e.g., `2024-01-15`) or spreadsheet serial numbers; payment amounts can include currency symbols and will be normalized automatically.

## Branding
- Name: **Sedifex**
- Tagline: *Sell faster. Count smarter.*
- Primary color: `#4338CA` (indigo 700)

---

Happy shipping! — 2025-09-23

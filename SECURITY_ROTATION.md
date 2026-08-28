# Secret rotation — 2026-07-30

This project was uploaded as a zip that included real-looking secrets
(`Backend/.env` and `Backend/serviceAccountKey.json`). Once a secret
has left your machine — even to a trusted party — the safe default is
to treat it as exposed and rotate it, rather than assume it's fine.
Here's exactly what was done and what's still on you.

## Done automatically (in this package)

- **`MONITOR_API_KEY`** — replaced with a new random 32-byte value in
  `Backend/.env`.
- **`KOBO_TOKEN_ENCRYPTION_KEY`** — replaced with a new random
  32-byte value in `Backend/.env`.

Both were generated with the same method the original comments in
`.env` specify:
```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Action required for these two

- **`MONITOR_API_KEY`** — the new value in `Backend/.env` only takes
  effect once you also set the identical value as `MONITOR_API_KEY`
  in the environment `Monitoring/monitor-disk-space.ps1` runs in on
  your Windows host (see `Backup System/BACKUP_STRATEGY.md`). Until
  you update both sides, the monitoring script's alerts will get
  logged locally and never posted — not a security hole, just a
  mismatch (per `verifyMonitorKey.js`'s own comment on that failure
  mode).
- **`KOBO_TOKEN_ENCRYPTION_KEY`** — rotating this makes the
  *previously stored* encrypted KoboToolbox token unrecoverable by
  design (this is called out directly in `koboService.js`'s header
  comment). After deploying this new key, go to the admin panel and
  run **Disconnect → Connect** again for KoboToolbox (`POST
  /api/kobo/disconnect` then `/connect`) to re-encrypt the token under
  the new key. Nothing else reads the old value, so there's no other
  cleanup.

## Not done automatically — needs your action

- **Firebase service account key** (`Backend/serviceAccountKey.json`).
  This is a live Google Cloud credential, not an app-generated secret
  — I have no access to your Google Cloud/Firebase account, so I
  can't revoke or regenerate it for you. **The file has been removed
  from this package** rather than re-included, since re-distributing
  a known-exposed private key doesn't help anyone.

  What was in it (safe to share — only the private key itself is
  sensitive):
  - Project ID: `geosurvey-update`
  - Service account: `firebase-adminsdk-fbsvc@geosurvey-update.iam.gserviceaccount.com`
  - Key ID: `212a30654d3aafebb4ef93eae8ce1078bdcd7424`

  **To rotate it:**
  1. Go to [Google Cloud Console → IAM & Admin → Service Accounts](https://console.cloud.google.com/iam-admin/serviceaccounts)
     for project `geosurvey-update`.
  2. Open `firebase-adminsdk-fbsvc@geosurvey-update.iam.gserviceaccount.com` → **Keys** tab.
  3. **Delete** the key with ID `212a30654d3aafebb4ef93eae8ce1078bdcd7424`
     (this immediately invalidates it — any exposed copy stops working).
  4. **Add Key → Create new key → JSON** to generate a replacement.
  5. Save the downloaded file as `Backend/serviceAccountKey.json`
     (already covered by `.gitignore` — never commit it) and redeploy.
  6. If `GOOGLE_APPLICATION_CREDENTIALS` in `.env` doesn't already
     point at that path, update it.

  Until step 3 is done, the old key remains valid and usable by
  anyone who has seen it.

## General note

Any other credentials that passed through this conversation or an
uploaded file (API tokens, database passwords, etc.) should get the
same treatment: rotate rather than assume they're still private.

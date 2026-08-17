# GeoSurvey — Company-Owned File Storage API

A Node.js + Express backend that stores uploaded photos and audio on
infrastructure the company controls (a disk/volume you own), while
still using **Firebase Authentication** as the single source of truth
for "who is this." It is a separate service from the existing
Firebase Hosting + Firestore app — deploy it wherever you run backend
services (Cloud Run, a VM, a container platform, on-prem, etc.).

## Why a separate backend, and why Firestore stays involved

- **Auth stays on Firebase.** Users keep signing in exactly as they do
  today (`firebaseAuth.js` / `session.js`). The frontend just also
  attaches `await user.getIdToken()` to requests made to this API.
- **File bytes leave Firebase Storage.** They're written to
  `STORAGE_ROOT` on a filesystem this backend controls
  (`services/fileStorageService.js`), organized by media type and then
  by survey:

  ```
  storage/
    photos/<surveyId>/photo_<timestamp>.jpg
    audio/<surveyId>/audio_<timestamp>.webm
    documents/<surveyId>/document_<timestamp>.pdf
  ```

  `surveyId` is client-supplied (sent as a form field alongside the
  file) and is validated against a strict allow-listed character set
  before it's ever used to build a path — see `assertSafeSurveyId` in
  `fileStorageService.js`. Nothing about who uploaded a file is encoded
  in its path; that's tracked in Firestore metadata instead, which is
  what access control actually checks (see below), so the on-disk
  layout staying human-browsable by survey doesn't weaken security.
- **Metadata stays in Firestore** (`companyFiles` collection, a new
  collection distinct from the app's existing ones), so there's one
  consistent record of "what files exist and who owns them," and the
  Admin SDK access here doesn't require touching `firestore.rules` for
  anything the frontend directly reads. Only these fields are ever
  stored — no file bytes, no extra fields:

  | Field                | Meaning                                                             |
  |-----------------------|----------------------------------------------------------------------|
  | `fileId`              | Firestore doc id (also the value returned as `id` from uploads)    |
  | `firebaseUid`         | Firebase Auth uid of whoever uploaded the file                     |
  | `surveyId`            | Which survey/submission the file belongs to                        |
  | `fileType`            | Sniffed MIME type of the actual bytes (e.g. `image/jpeg`)          |
  | `filePath`            | Path relative to `STORAGE_ROOT`, e.g. `photos/survey-42/photo_....jpg` |
  | `uploadDate`          | Firestore server timestamp                                          |
  | `fileSize`            | Size in bytes                                                        |
  | `accessPermissions`   | `{ ownerUid, allowedRoles, allowedUids }` — see below               |

  `accessPermissions` defaults to `{ ownerUid: <uploader>, allowedRoles:
  ['admin', 'supervisor'], allowedUids: [] }` at upload time
  (`fileMetadataService.js`), matching this app's existing role model.
  `allowedUids` starts empty and exists so a specific file could be
  shared with named users later without a schema change.
  `utils/authorizeFileAccess.js` evaluates this on every `GET`/`DELETE`
  — driven by each record's own permissions, not a hardcoded rule.

## Request flow

```
Frontend                          Backend
--------                          -------
sign in (firebaseAuth.js)
getIdToken()
POST /api/upload/photo  ───────►  verify ID token (Admin SDK)
  Authorization: Bearer <token>   check users/{uid}.active/role
  multipart/form-data:            validate surveyId (safe charset)
    file: <bytes>                 validate declared mimetype + size
    surveyId: <id>                sniff real file type from bytes
                                   write bytes to
                                     storage/photos/<surveyId>/photo_<ts>.<ext>
                                   write metadata doc to Firestore
                          ◄──────  { id, surveyId, category, mime, bytes, ... }
```

`GET /api/files/:id` and `DELETE /api/files/:id` follow the same
token-verification step, then check the caller against that file's own
`accessPermissions` (`utils/authorizeFileAccess.js`) before doing
anything. `:id` is `fileId` — the Firestore metadata doc's id, returned
from the upload call — not a filename; clients never need to know the
on-disk path.

## Setup

```bash
cd backend
cp .env.example .env      # fill in FIREBASE_SERVICE_ACCOUNT_JSON (or
                           # GOOGLE_APPLICATION_CREDENTIALS), STORAGE_ROOT,
                           # ALLOWED_ORIGINS
npm install
npm start                 # or: npm run dev
```

`STORAGE_ROOT` must point at a writable, persistent volume — for a
container platform, mount a persistent disk/volume there rather than
using container-ephemeral storage, or the files will disappear on
redeploy.

### Two `package.json` files — this is intentional

This repo has two separate manifests, not one that got duplicated by
mistake:

- **`/package.json`** (`geosurvey-file-storage-api`) drives the actual
  Express API in this README — `npm install` / `npm start` / `npm test`
  at the repo root use this one, and its `main` points at
  `Backend/server.js`.
- **`Backend/package.json`** (`geosurvey-functions`) is a separate,
  dependency-light manifest for the Cloud Function in `Backend/index.js`
  (push notification delivery). It's only used by the Firebase CLI —
  `firebase.json` sets `functions.source: "Backend"`, so `firebase
  deploy --only functions` reads `Backend/package.json`, not the root
  one.

If you're running the API, install/deploy from the repo root. If
you're deploying the Cloud Function, that goes through the Firebase
CLI and reads `Backend/package.json` instead. Don't `cd Backend && npm
install` expecting the Express app's dependencies — they're not in
that manifest.

## Endpoints

| Method | Path                    | Auth required | Body |
|--------|-------------------------|---------------|------|
| POST   | `/api/upload/photo`     | Bearer ID token | `multipart/form-data`: `file` (jpeg/png/webp/heic, ≤15MB by default), `surveyId` |
| POST   | `/api/upload/audio`     | Bearer ID token | `multipart/form-data`: `file` (mp3/m4a/wav/webm/ogg, ≤25MB by default), `surveyId` |
| POST   | `/api/upload/document`  | Bearer ID token | `multipart/form-data`: `file` (pdf/csv/txt/docx/xlsx, ≤20MB by default), `surveyId` |
| GET    | `/api/files/:id`        | Bearer ID token | — (streams the file back) |
| DELETE | `/api/files/:id`        | Bearer ID token | — (204 on success) |

`surveyId` must match `^[A-Za-z0-9_-]{1,128}$` — it becomes a directory
name on disk, so anything outside that set (including `..` or `/`) is
rejected with a 400 before it reaches the filesystem.

All error responses are JSON: `{ "error": "..." }`.

## Security notes

- **Declared mimetype is never trusted.** `multer`'s `fileFilter`
  rejects obviously wrong `Content-Type` values up front, but the
  actual storage/response mimetype comes from sniffing the real file
  bytes (`file-type` package) after upload — a client lying in the
  multipart headers can't get a file mis-typed or smuggle an
  unexpected type through.
- **Filenames on disk are never client-controlled.** Stored paths are
  `STORAGE_ROOT/<photos|audio|documents>/<surveyId>/<category>_<timestamp>.<ext>`.
  The filename itself (`photo_<timestamp>.jpg`, etc.) is entirely
  server-generated — the client's original filename is kept only as
  metadata (`originalName`), never used to build a path. `surveyId` IS
  client-supplied and does become a path segment, so it's the one
  thing validated against a strict allow-list (`assertSafeSurveyId` in
  `fileStorageService.js`) before use, reinforced by an explicit
  "resolved path must stay under STORAGE_ROOT" check (`safeResolve`,
  same file) as a second line of defense against path traversal.
- **Filename collisions never overwrite a prior file.** Two uploads
  landing in the same survey in the same millisecond get a
  disambiguating suffix (`photo_<timestamp>-1.jpg`) rather than one
  silently clobbering the other — writes use the `wx` flag, which fails
  if the target path already exists.
- **Token revocation is honored immediately.** `verifyIdToken(token,
  true)` checks Firebase's revocation list, so a user who is
  force-signed-out (or whose refresh tokens are revoked) loses upload
  access right away, not just after their current token's natural
  ~1 hour expiry.
- **Role/active status is re-checked from Firestore on every request**
  — never cached — for the same reason `session.js` re-checks it on
  every app load: a demoted or disabled account must lose access
  immediately.
- **CORS is allow-listed** via `ALLOWED_ORIGINS`; set this to your
  actual deployed frontend origin(s) before going to production.
- Consider adding a virus/malware scan step (e.g. ClamAV, or a cloud
  provider's file-scanning service) between upload and write-to-disk
  if this API will ever accept files from less-trusted users — the
  scaffolding here validates *type* and *size*, not file safety.

## Frontend integration

`PWA/js/auth/fileStorageClient.js` is a drop-in module written in the
same style as the other files in `PWA/js/auth/` — it imports
`getCurrentUser` from `session.js`, attaches a fresh ID token to every
call, and exposes `uploadPhoto(file, surveyId)`,
`uploadAudio(file, surveyId)`, `uploadDocument(file, surveyId)`,
`getFileBlob(id)`, and `deleteFile(id)`. It's already imported from
`PWA/js/app.js` the same way the app imports the other
`PWA/js/auth/` modules; set `FILE_API_BASE_URL` inside it to your
deployed backend's URL.

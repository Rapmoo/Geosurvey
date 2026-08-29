# GeoSurvey — PWA setup notes

This app is now a real installable, offline-capable PWA (manifest + service
worker + install prompt), and is wired for real push notifications via
Firebase Cloud Messaging. Two things need to be done in your Firebase
project before push notifications fully work end-to-end — everything else
already works as soon as you deploy these files.

## Files added

```
index2.html        (updated — manifest link, SW registration, install button, push UI)
manifest.json       Web app manifest (name, icons, colors, display mode)
sw.js               Service worker: offline app-shell caching + FCM background handler
icons/              App icons generated to match your existing brand mark
functions/          Cloud Function that actually delivers push when the app is closed
```

Deploy all of these to the same directory your app is served from (so
`sw.js`'s root scope covers the whole app). If you rename `index2.html` to
something else (e.g. `index.html`), update the matching path in
`manifest.json` (`start_url`, `scope`, `id`) and in `sw.js`
(`SHELL_URLS`'s first entry).

**HTTPS (or localhost) is required** — service workers and install prompts
are both blocked on plain http.

## 1. Generate a Web Push VAPID key

Firebase Console → Project settings → Cloud Messaging → **Web Push
certificates** → Generate key pair. Copy the key and paste it into
`index2.html` in place of:

```js
const VAPID_KEY = "REPLACE_WITH_YOUR_WEB_PUSH_VAPID_KEY";
```

Without this, `Notification.requestPermission()` still works, but the app
can't obtain an FCM registration token, so "Enable" in Account Settings →
Push notifications will fail with a friendly error toast instead of
actually registering the device.

## 2. Deploy the Cloud Function

In-app notifications (the bell icon) already work with no extra setup —
they're just a Firestore listener, and that only requires the app tab to
be open. To actually push a notification to a closed app/browser, a
server has to trigger the send; that's what `functions/index.js` does. It
watches new docs in the `notifications` collection (the same ones your
existing admin/supervisor code already writes) and sends via
`admin.messaging().sendEachForMulticast()` to every token stored on that
user's `users/{uid}.fcmTokens` array.

```bash
firebase init functions      # if you haven't already, point it at the functions/ folder
firebase deploy --only functions
```

This requires the Blaze (pay-as-you-go) plan, same as Firebase Storage
already in use elsewhere in this app.

## 3. Firestore security rules

Make sure your rules allow a signed-in user to update `fcmTokens` on their
own `users/{uid}` document (the same rule that already lets them update
`personalEmail` from Account Settings should cover this — just confirm
`fcmTokens` isn't excluded by an explicit field allow-list if you have one).

## What now actually works (vs. before)

- **Installable** — Chrome/Edge/Android show a real install prompt (not a
  fake button); the app opens in its own window, with icons and a splash
  screen from `manifest.json`. iOS Safari gets a one-time "Add to Home
  Screen" instruction since it has no install API at all.
- **Works offline** — `sw.js` precaches the app shell and CDN libraries
  (Leaflet, fonts, Firebase SDK) on first load, so reopening the app with
  no connection loads the UI instead of a browser error page. Firestore's
  own offline cache (already in this app) continues to handle your actual
  data.
- **Updates** — when you redeploy a new version of the app, open tabs get
  a small "reload" prompt instead of silently running a stale cached copy
  forever.
- **Real push notifications** — a device that opted in (Account Settings →
  Push notifications → Enable) gets a system notification even with the
  browser fully closed, once the Cloud Function above is deployed.

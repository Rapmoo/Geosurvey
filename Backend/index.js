/**
 * GeoSurvey — push delivery Cloud Function
 * ---------------------------------------------------------------
 * The client (index2.html) already writes a document to the
 * "notifications" collection for in-app alerts. That's enough for
 * someone with the tab open, but a browser can't push a message to a
 * device that isn't running your page — only a server can do that,
 * using the Firebase Admin SDK. This function is that server: it
 * watches for new "notifications" docs and sends a real push to every
 * FCM token stored on the target user's profile (users/{uid}.fcmTokens).
 *
 * Firebase Admin is initialized once, in config/firebaseAdmin.js, and
 * reused here — don't call admin.initializeApp() again in this file.
 * A second initializeApp() call in the same process throws, and it
 * would bypass the shared, already-configured instance (credentials,
 * project id) that the rest of the backend relies on.
 *
 * Deploy with the Firebase CLI:
 *   firebase deploy --only functions
 *
 * Requires the project to be on the Blaze (pay-as-you-go) plan, same
 * as Firebase Storage already in use elsewhere in this app.
 */
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { setGlobalOptions } = require('firebase-functions/v2');
const { admin, db } = require('./config/firebaseAdmin');

setGlobalOptions({ maxInstances: 10 });

exports.sendPushOnNotificationCreate = onDocumentCreated('notifications/{notificationId}', async (event) => {
  const snap = event.data;
  if (!snap) return;
  const notif = snap.data();
  const userUid = notif.userUid;
  if (!userUid) return;

  const userSnap = await db.collection('users').doc(userUid).get();
  if (!userSnap.exists) return;
  const tokens = userSnap.data().fcmTokens;
  if (!Array.isArray(tokens) || tokens.length === 0) return; // nobody opted in on any device

  const message = {
    notification: {
      title: notif.title || 'GeoSurvey',
      body: notif.comment || '',
    },
    data: {
      // Everything here must be a string — FCM data payloads don't
      // accept other types. sw.js reads these on notificationclick.
      notificationId: event.params.notificationId,
      type: notif.type || '',
      formId: notif.formId || '',
      formName: notif.formName || '',
      submissionId: notif.submissionId || '',
    },
    tokens,
  };

  const response = await admin.messaging().sendEachForMulticast(message);

  // Prune tokens that are no longer valid (app uninstalled, permission
  // revoked, browser data cleared, etc.) so this list doesn't grow stale.
  const staleTokens = [];
  response.responses.forEach((res, idx) => {
    if (!res.success) {
      const code = res.error && res.error.code;
      if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
        staleTokens.push(tokens[idx]);
      }
    }
  });
  if (staleTokens.length) {
    await db.collection('users').doc(userUid).update({
      fcmTokens: admin.firestore.FieldValue.arrayRemove(...staleTokens),
    });
  }
});

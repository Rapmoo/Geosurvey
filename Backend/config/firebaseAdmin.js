
const admin = require('firebase-admin');
const path = require('path');

function loadCredential() {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    // Resolve relative to this file's directory (Backend/), not
    // process.cwd() -- applicationDefault() resolves relative paths
    // against cwd, which breaks when npm start is run from the repo
    // root (cwd = repo root) while GOOGLE_APPLICATION_CREDENTIALS is
    // a relative path meant to point inside Backend/.
    const resolvedPath = path.isAbsolute(process.env.GOOGLE_APPLICATION_CREDENTIALS)
      ? process.env.GOOGLE_APPLICATION_CREDENTIALS
      : path.join(__dirname, '..', process.env.GOOGLE_APPLICATION_CREDENTIALS);
    return admin.credential.cert(require(resolvedPath));
  }
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const parsed = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    return admin.credential.cert(parsed);
  }
  // No explicit credential source configured. Running inside Google
  // Cloud (e.g. this file required from a Cloud Function) still works:
  // applicationDefault() picks up ambient credentials from the
  // metadata server with no env var needed. Running truly outside GCP
  // with nothing configured will fail fast when firebase-admin tries
  // to actually use these credentials, which is the right behavior.
  return admin.credential.applicationDefault();
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: loadCredential(),
    projectId: process.env.FIREBASE_PROJECT_ID,
  });
}

module.exports = {
  admin,
  auth: admin.auth(),
  db: admin.firestore(),
};

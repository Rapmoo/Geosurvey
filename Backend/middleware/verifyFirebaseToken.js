
const { auth, db } = require('../config/firebaseAdmin');

async function verifyFirebaseToken(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header. Expected: Bearer <idToken>' });
  }

  let decoded;
  try {
    // checkRevoked: true adds a Firestore lookup on Firebase's side but
    // means signOut()/revokeRefreshTokens() on a compromised account
    // takes effect immediately here too, not just after the token's
    // natural ~1hr expiry.
    decoded = await auth.verifyIdToken(token, /* checkRevoked */ true);
  } catch (err) {
    if (err.code === 'auth/id-token-revoked') {
      return res.status(401).json({ error: 'Session revoked. Please sign in again.' });
    }
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }

  let profileSnap;
  try {
    profileSnap = await db.collection('users').doc(decoded.uid).get();
  } catch (err) {
    return res.status(503).json({ error: 'Could not verify account status. Try again shortly.' });
  }

  if (!profileSnap.exists) {
    return res.status(403).json({ error: 'No GeoSurvey profile for this account.' });
  }

  const profile = profileSnap.data();
  if (profile.active === false) {
    return res.status(403).json({ error: 'This account has been disabled.' });
  }

  req.uid = decoded.uid;
  req.userProfile = { uid: decoded.uid, role: profile.role, active: profile.active !== false };
  next();
}

module.exports = { verifyFirebaseToken };


import { getCurrentUserAsync } from './session.js';

const FILE_API_BASE_URL =
  (typeof window !== 'undefined' && window.GEOSURVEY_CONFIG && window.GEOSURVEY_CONFIG.FILE_API_BASE_URL) ||
  (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_FILE_API_BASE_URL) ||
  (typeof process !== 'undefined' && process.env && (process.env.REACT_APP_FILE_API_BASE_URL || process.env.FILE_API_BASE_URL)) ||
  "http://localhost:8080/api";

if (FILE_API_BASE_URL === "http://localhost:8080/api" && typeof window !== 'undefined' && window.location && window.location.hostname !== 'localhost') {
  // Loud warning instead of a silent wrong-server call: we're running
  // on a non-localhost host but no env var was set, so we're about to
  // fall back to a URL that can't possibly be reachable from here.
  console.warn(
    '[fileStorage] FILE_API_BASE_URL fell back to localhost while running on host "' +
    window.location.hostname + '". Set VITE_FILE_API_BASE_URL / REACT_APP_FILE_API_BASE_URL ' +
    'to your deployed backend URL — uploads will otherwise fail silently or with a network error.'
  );
}

async function getIdToken() {
  const user = await getCurrentUserAsync();
  if (!user) {
    console.warn('[fileStorage] getIdToken(): auth state resolved with no signed-in user — refusing call.');
    throw new Error('No signed-in user — cannot call the file storage API.');
  }
  try {
    const token = await user.getIdToken();
    console.log('[fileStorage] getIdToken(): token retrieved for uid', user.uid);
    return token;
  } catch (err) {
    console.error('[fileStorage] getIdToken(): user.getIdToken() failed for uid', user.uid, err);
    throw err;
  }
}

async function parseJsonOrThrow(response) {
  let body = null;
  try { body = await response.json(); } catch (_) { /* no body */ }
  if (!response.ok) {
    const message = (body && body.error) || `Request failed with status ${response.status}`;
    const err = new Error(message);
    err.status = response.status;
    throw err;
  }
  return body;
}

/**
 * uploadPhoto(file, surveyId, formId, opts) / uploadAudio(...) / uploadDocument(...)
 * `file` is a File/Blob. `surveyId` determines the file's sub-folder on
 * the backend; `formId` determines its top-level (form) folder — see
 * the FORM-FOLDER ORGANIZATION note above. `opts.onProgress(fractionComplete)`
 * is called repeatedly (0..1) as the upload streams — this is what makes
 * real progress UI possible, which `fetch()` cannot do reliably for
 * uploads, so this uses XMLHttpRequest instead. `opts.signal` (an
 * AbortSignal) lets a caller cancel an in-flight upload.
 *
 * Returns the created file record: { fileId, firebaseUid, surveyId,
 * formId, fileType, filePath, uploadDate, fileSize, accessPermissions }.
 */
function uploadPhoto(file, surveyId, formId, opts) { return uploadTo('upload/photo', file, surveyId, formId, opts); }
function uploadAudio(file, surveyId, formId, opts) { return uploadTo('upload/audio', file, surveyId, formId, opts); }
function uploadDocument(file, surveyId, formId, opts) { return uploadTo('upload/document', file, surveyId, formId, opts); }

function uploadTo(path, file, surveyId, formId, { onProgress, signal } = {}) {
  if (!surveyId) return Promise.reject(new Error('surveyId is required for uploads.'));
  if (!formId) return Promise.reject(new Error('formId is required for uploads.'));

  return getIdToken().then((idToken) => new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', file, file.name || undefined);
    form.append('surveyId', surveyId);
    form.append('formId', formId);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${FILE_API_BASE_URL}/${path}`);
    xhr.setRequestHeader('Authorization', `Bearer ${idToken}`);

    if (signal) {
      if (signal.aborted) { xhr.abort(); return reject(new DOMException('Upload aborted', 'AbortError')); }
      signal.addEventListener('abort', () => xhr.abort());
    }

    if (onProgress) {
      xhr.upload.onprogress = (evt) => {
        if (evt.lengthComputable) onProgress(evt.loaded / evt.total);
      };
    }

    xhr.onerror = () => reject(new Error('Network error during upload.'));
    xhr.onabort = () => reject(new DOMException('Upload aborted', 'AbortError'));
    xhr.onload = () => {
      let body = null;
      try { body = JSON.parse(xhr.responseText); } catch (_) { /* no/invalid body */ }
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress && onProgress(1);
        return resolve(body);
      }
      const err = new Error((body && body.error) || `Upload failed with status ${xhr.status}`);
      err.status = xhr.status;
      reject(err);
    };

    xhr.send(form);
  }));
}

/**
 * getFileBlob(fileId) — fetch a previously uploaded file's bytes as a
 * Blob, e.g. to render `URL.createObjectURL(blob)` into an <img>/<audio>.
 */
async function getFileBlob(fileId) {
  const idToken = await getIdToken();
  const response = await fetch(`${FILE_API_BASE_URL}/files/${encodeURIComponent(fileId)}`, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const err = new Error((body && body.error) || `Could not fetch file ${fileId}`);
    err.status = response.status;
    throw err;
  }
  return response.blob();
}

/**
 * getMediaObjectUrl(fileId) — convenience wrapper for the common
 * "assign this to an <img>/<audio> src" case. Caller is responsible
 * for calling URL.revokeObjectURL(url) once the element no longer
 * needs it (e.g. when it's removed from the DOM / view is closed).
 */
async function getMediaObjectUrl(fileId) {
  const blob = await getFileBlob(fileId);
  return URL.createObjectURL(blob);
}

/**
 * deleteFile(fileId) — deletes both the stored bytes and the metadata
 * record. Only succeeds for the file's owner or an account whose role
 * is listed in that file's accessPermissions.allowedRoles.
 */
async function deleteFile(fileId) {
  const idToken = await getIdToken();
  const response = await fetch(`${FILE_API_BASE_URL}/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (!response.ok && response.status !== 204) {
    const body = await response.json().catch(() => null);
    throw new Error((body && body.error) || `Could not delete file ${fileId}`);
  }
}

export { uploadPhoto, uploadAudio, uploadDocument, getFileBlob, getMediaObjectUrl, deleteFile };
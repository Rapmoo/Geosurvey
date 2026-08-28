# Security

This folder is a placeholder for security-related documentation,
mirroring the layout of `Backup System/`, `Monitoring/`, and
`Firebase Authentication/` (each holds docs/config for one subsystem,
while the actual code lives under `Backend/`).

It was empty in this checkout. The security work itself is fully
implemented and documented elsewhere in the repo — this folder just
never got its own docs written.

## Where the actual security documentation and implementation live

| Concern | File |
|---|---|
| What security requirements were added/changed, and when | `SECURITY_CHANGES.md` (root) |
| Credential rotation history and pending rotation steps | `SECURITY_ROTATION.md` (root) |
| Firestore access rules (default-deny, role checks) | `Firebase Authentication/firestore.rules` |
| Firebase ID token verification | `Backend/middleware/verifyFirebaseToken.js` |
| Role-based access control | `Backend/middleware/requireRole.js`, `Backend/utils/roles.js` |
| Per-file access control | `Backend/utils/authorizeFileAccess.js` |
| Upload type/size validation (magic-byte sniffing) | `Backend/middleware/uploadValidation.js` |
| Path-traversal prevention | `Backend/services/fileStorageService.js` (`assertSafeSurveyId`, `safeResolve`) |
| Malware/virus scanning | `Backend/services/malwareScanService.js` |
| Audit logging (uploads/downloads/deletes) | `Backend/services/auditLogService.js` |
| Monitor-key auth for the disk-space watchdog | `Backend/middleware/verifyMonitorKey.js` |

If this folder is meant to hold something more specific (a threat
model, a pen-test report, an incident-response runbook, etc.), add it
here.

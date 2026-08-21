# File Storage System

This folder is a placeholder for documentation about the company-owned
file storage subsystem, mirroring the layout of `Backup System/`,
`Monitoring/`, and `Firebase Authentication/` (each holds docs/config
for one subsystem, while the actual code lives under `Backend/`).

It was empty in this checkout. The subsystem itself is fully
implemented — this folder just never got its docs written. The
canonical description of how it works is in the root `README.md`
("Why a separate backend, and why Firestore stays involved").

## Where the actual implementation lives

| Concern | File |
|---|---|
| Writing/reading bytes on disk (`STORAGE_ROOT`) | `Backend/services/fileStorageService.js` |
| Firestore metadata (`companyFiles` collection) | `Backend/services/fileMetadataService.js` |
| Upload endpoints | `Backend/routes/upload.js` |
| Download/delete endpoints | `Backend/routes/files.js` |
| Per-file access control | `Backend/utils/authorizeFileAccess.js` |
| Upload validation (type/size sniffing) | `Backend/middleware/uploadValidation.js` |
| Malware scanning hook | `Backend/services/malwareScanService.js` |
| Disk usage monitoring | `Backend/services/storageMonitorService.js` |
| Frontend upload client | `PWA/auth/fileStorageClient.js` |
| Offline upload queue | `PWA/auth/uploadQueue.js` |

If this folder is meant to hold something more specific (an ops
runbook, a storage layout diagram, etc.), add it here.

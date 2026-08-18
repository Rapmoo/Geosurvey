/* ===================================================================
   authorizeFileAccess.test.js
   ---------------------------------------------------------------
   canAccessFile is the single function every GET/DELETE on a file
   goes through (routes/files.js). It's pure and has no external
   dependencies, so these are plain unit tests — but the logic is
   exactly the kind of thing that's easy to get subtly wrong (e.g.
   flipping a role check, or treating a missing array as "allow
   everyone" instead of "allow no one"), so it gets deliberately
   thorough coverage here.
   =================================================================== */
const { canAccessFile } = require('../../utils/authorizeFileAccess');
const { ROLES } = require('../../utils/roles');

function makeRecord(overrides = {}) {
  return {
    accessPermissions: {
      ownerUid: 'owner-uid',
      allowedRoles: [ROLES.ADMIN, ROLES.SUPERVISOR],
      allowedUids: [],
    },
    ...overrides,
  };
}

describe('canAccessFile', () => {
  test('owner can always access their own file', () => {
    const record = makeRecord();
    const owner = { uid: 'owner-uid', role: ROLES.WORKER };
    expect(canAccessFile(owner, record)).toBe(true);
  });

  test('a worker who is not the owner and not explicitly shared is denied', () => {
    const record = makeRecord();
    const otherWorker = { uid: 'someone-else', role: ROLES.WORKER };
    expect(canAccessFile(otherWorker, record)).toBe(false);
  });

  test('admin role is allowed via allowedRoles, even without ownership', () => {
    const record = makeRecord();
    const admin = { uid: 'admin-uid', role: ROLES.ADMIN };
    expect(canAccessFile(admin, record)).toBe(true);
  });

  test('supervisor role is allowed via allowedRoles, even without ownership', () => {
    const record = makeRecord();
    const supervisor = { uid: 'supervisor-uid', role: ROLES.SUPERVISOR };
    expect(canAccessFile(supervisor, record)).toBe(true);
  });

  test('worker role is never granted access purely by role (no implicit elevated access)', () => {
    const record = makeRecord({
      accessPermissions: {
        ownerUid: 'owner-uid',
        allowedRoles: [ROLES.ADMIN, ROLES.SUPERVISOR], // worker deliberately absent
        allowedUids: [],
      },
    });
    const worker = { uid: 'not-the-owner', role: ROLES.WORKER };
    expect(canAccessFile(worker, record)).toBe(false);
  });

  test('a uid explicitly listed in allowedUids is granted access regardless of role', () => {
    const record = makeRecord({
      accessPermissions: {
        ownerUid: 'owner-uid',
        allowedRoles: [ROLES.ADMIN],
        allowedUids: ['shared-with-me'],
      },
    });
    const sharedUser = { uid: 'shared-with-me', role: ROLES.WORKER };
    expect(canAccessFile(sharedUser, record)).toBe(true);
  });

  test('a uid NOT in allowedUids and not owner/elevated is denied', () => {
    const record = makeRecord({
      accessPermissions: {
        ownerUid: 'owner-uid',
        allowedRoles: [ROLES.ADMIN],
        allowedUids: ['shared-with-someone-else'],
      },
    });
    const randomUser = { uid: 'not-shared', role: ROLES.WORKER };
    expect(canAccessFile(randomUser, record)).toBe(false);
  });

  test('missing file record is always denied (never throws)', () => {
    expect(canAccessFile({ uid: 'anyone', role: ROLES.ADMIN }, null)).toBe(false);
    expect(canAccessFile({ uid: 'anyone', role: ROLES.ADMIN }, undefined)).toBe(false);
  });

  test('missing accessPermissions on a record denies everyone, including admins', () => {
    const record = { accessPermissions: undefined };
    const admin = { uid: 'admin-uid', role: ROLES.ADMIN };
    expect(canAccessFile(admin, record)).toBe(false);
  });

  test('malformed allowedRoles/allowedUids (not arrays) fail closed rather than throwing', () => {
    const record = makeRecord({
      accessPermissions: {
        ownerUid: 'owner-uid',
        allowedRoles: 'admin', // wrong type: should be an array
        allowedUids: null,      // wrong type: should be an array
      },
    });
    const admin = { uid: 'admin-uid', role: ROLES.ADMIN };
    expect(() => canAccessFile(admin, record)).not.toThrow();
    expect(canAccessFile(admin, record)).toBe(false);
  });

  test('empty allowedRoles and allowedUids deny everyone except the owner', () => {
    const record = makeRecord({
      accessPermissions: { ownerUid: 'owner-uid', allowedRoles: [], allowedUids: [] },
    });
    expect(canAccessFile({ uid: 'owner-uid', role: ROLES.WORKER }, record)).toBe(true);
    expect(canAccessFile({ uid: 'admin-uid', role: ROLES.ADMIN }, record)).toBe(false);
  });

  test('an empty-string uid never accidentally matches an unset ownerUid', () => {
    const record = makeRecord({
      accessPermissions: { ownerUid: undefined, allowedRoles: [], allowedUids: [] },
    });
    expect(canAccessFile({ uid: '', role: ROLES.WORKER }, record)).toBe(false);
  });
});

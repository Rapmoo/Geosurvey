/* ===================================================================
   requireRole.test.js
   ---------------------------------------------------------------
   requireRole is the generic role gate for endpoints that aren't
   about a specific file (e.g. GET /api/admin/storage-status). It
   must run after verifyFirebaseToken, so it trusts req.userProfile.role
   is already populated correctly — these tests exercise the gate in
   isolation with a hand-built req.
   =================================================================== */
const { requireRole } = require('../../middleware/requireRole');
const { ROLES } = require('../../utils/roles');

function makeRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('requireRole', () => {
  test('allows a request whose role is in the allowlist', () => {
    const middleware = requireRole(ROLES.ADMIN);
    const req = { userProfile: { uid: 'u1', role: ROLES.ADMIN } };
    const res = makeRes();
    const next = jest.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  test('allows a request whose role matches any of multiple allowed roles', () => {
    const middleware = requireRole(ROLES.ADMIN, ROLES.SUPERVISOR);
    const req = { userProfile: { uid: 'u1', role: ROLES.SUPERVISOR } };
    const res = makeRes();
    const next = jest.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  test('rejects a request whose role is not in the allowlist with 403', () => {
    const middleware = requireRole(ROLES.ADMIN);
    const req = { userProfile: { uid: 'u1', role: ROLES.WORKER } };
    const res = makeRes();
    const next = jest.fn();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Not authorized for this endpoint.' });
  });

  test('rejects when req.userProfile is missing entirely (e.g. gate misordered before auth)', () => {
    const middleware = requireRole(ROLES.ADMIN);
    const req = {};
    const res = makeRes();
    const next = jest.fn();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('supervisor is rejected from an admin-only endpoint', () => {
    const middleware = requireRole(ROLES.ADMIN);
    const req = { userProfile: { uid: 'u1', role: ROLES.SUPERVISOR } };
    const res = makeRes();
    const next = jest.fn();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

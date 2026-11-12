// The Sieve admin page check: ADMIN_EMAILS or users.is_admin, and only for the account owner (never a team member).
const test = require('node:test');
const assert = require('node:assert/strict');
const { isAdminUser } = require('../adminAccess');

test('admin access: is_admin or ADMIN_EMAILS, owners only', () => {
  process.env.ADMIN_EMAILS = 'boss@vasnet.ng, other@vasnet.ng';
  assert.equal(isAdminUser({ email: 'boss@vasnet.ng', is_admin: false }, true), true, 'listed email');
  assert.equal(isAdminUser({ email: 'BOSS@vasnet.ng', is_admin: false }, true), true, 'any letter case');
  assert.equal(isAdminUser({ email: 'shop@x.ng', is_admin: true }, true), true, 'is_admin flag');
  assert.equal(isAdminUser({ email: 'shop@x.ng', is_admin: false }, true), false, 'a normal business');
  assert.equal(isAdminUser({ email: 'boss@vasnet.ng', is_admin: true }, false), false, 'a team member of an admin account is not an admin');
  delete process.env.ADMIN_EMAILS;
  assert.equal(isAdminUser({ email: 'boss@vasnet.ng', is_admin: false }, true), false, 'nothing set: no access');
});

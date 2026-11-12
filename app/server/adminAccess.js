// Who counts as a Sieve admin: the account owner (never a team member) whose account has is_admin = true, or whose
// email is listed in the ADMIN_EMAILS setting (comma-separated). Used by the admin API and by /api/auth/me.
function isAdminUser(user, isOwner) {
  if (!user || !isOwner) return false;
  const list = String(process.env.ADMIN_EMAILS || '').toLowerCase().split(/[,\s]+/).filter(Boolean);
  return !!user.is_admin || list.includes(String(user.email || '').toLowerCase());
}
module.exports = { isAdminUser };

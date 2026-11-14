# Sieve security check: November 2026

Plain-English summary of the second security pass on Sieve (sieve.com.ng).
The first pass was commit `82de94d`. This one re-checked all of it and fixed what was still open.

**Status:** the fixes are made on this computer and tested. They are **not live yet**. Deploying needs your OK.

---

## The one serious problem (fixed)

**A single payment could be used again and again to add credits.**
When someone bought credits, Sieve checked with Paystack that the payment was real, but it never noted that the
payment had already been used. Someone who paid ₦6,589 once could send the same payment reference again and get
50 more credits each time. A second account could use it too. The same was true for plans and the card check.

Now each Paystack payment can be used **once, by one account**. The database itself refuses a second use, even if
two requests arrive at the same moment. Credit purchases made before this fix are recorded too, so old payments
can't be reused either.

Also fixed alongside it:
- If the Paystack secret key were ever missing on the live server, Sieve used to treat every payment as successful
  (that "pretend" mode is meant only for testing on a laptop). On the live server it now refuses the payment instead.
- Payments must be in naira.

---

## Your checklist

| Item | Before this pass | Now |
|---|---|---|
| Real login, passwords hashed | Already fine: bcrypt, strong setting, 8–72 characters | Same |
| API keys kept on the server | Already fine: only Paystack's *public* key reaches the browser | Same |
| People only see their own data | Already fine: every scorecard, lead and team action checks the owner | Same, now with a test that tries to read, edit, publish and delete someone else's scorecard |
| HTTPS everywhere | Already fine: plain http is redirected, and browsers are told to always use HTTPS (checked live) | Same |
| Forms checked on the server | Mostly fine | A few forms crashed on odd input (e.g. a list where an email should be). They now give a clear "please fix this" message. Team invites now check the email looks real |
| XSS blocked | Already fine: text is made safe before showing, and pages only run Sieve's own scripts | One small spot on the public scorecard page (the "not available" message) now also makes its text safe |
| Safe database queries (no SQL injection) | Already fine: every query uses placeholders; nothing glues user text into SQL | Same. Report links now only accept a real lead ID |
| Rate-limited login | Already fine: 20 tries per 15 min per connection, and 8 wrong passwords lock that email for 15 min | Picture uploads (40 an hour) and PDF downloads (30 per 10 min) are now limited too |
| CSRF protection | Already fine: requests from other websites are refused | Tighter: a signed-in change that doesn't say where it came from is now refused (real browsers always say) |
| Secure session cookies | Already fine: hidden from page scripts, HTTPS only, ends on logout or password change | On the live site the cookie now uses the stricter `__Host-` name, so no other site or subdomain can plant or overwrite it |
| Reset links expire | Already fine: 1 hour, used once, stored scrambled; resetting signs out every old login | Same |
| Upload limits | Already fine: 3 MB, JPG/PNG/WEBP/GIF only, the file's contents must really be a picture | Same, plus the hourly limit above |
| Admin pages locked | Already fine: only the owner of an admin account; team members never get in | Same (tested) |
| Prices re-checked on the server | Already fine: prices live on the server and the amount paid is checked with Paystack | Each payment is now usable once (the big fix above) |
| Debug mode off | Already fine: live errors show a plain message, no technical details | If the email service key is ever missing on the live site, Sieve no longer writes full emails (with reset links) into the logs |
| Risky / unused packages | `npm audit`: **0 known problems**. All 9 packages are in use | Nothing to remove |
| Leaked keys in git history | Scanned all 56 commits: **no real keys found**. Only the placeholder values in `.env.example` | Nothing to replace |

---

## Tests

- New test file: `app/server/test/hardening.test.js`. It covers payment reuse (same account, another account, two at
  once, credits vs plan vs card), no fake payments on the live server, the stricter CSRF rule, the cookie, odd form
  input, report links, and one account trying to touch another's scorecard.
- The whole suite ran against a real Postgres database (not a fake one): **103 of 104 pass.**
- Three older tests were out of date and are now updated. They still expected the old 100-credit bundle and the old
  wording visitors saw on a paused scorecard. The test helper now sends requests the way a browser does.
- **The 1 that still fails was failing before this pass and isn't about security.** On a result page, a section's
  wording written by the business owner is being replaced by Sieve's generated wording. The test expects the owner's
  wording to win. You decide which is right (see below).

---

## What still needs you

1. **Say yes to deploy.** Nothing is live until then.
2. **Everyone gets logged out once** after the deploy, because of the new cookie name. They just log in again.
3. **Paystack is still on TEST keys on the live site** (checked live). Real customers can't pay until you switch to
   live keys: Paystack dashboard → Settings → API Keys, then put both keys (`PAYSTACK_PUBLIC_KEY`,
   `PAYSTACK_SECRET_KEY`) on the Railway "sieve" service. With this fix, a missing secret key now blocks payments
   instead of giving things away free.
4. **Check the email key is set** (`RESEND_API_KEY` on Railway's "sieve" service). Without it, reset links and invites
   aren't sent. I couldn't check it from here.
5. **No keys need changing.** Nothing leaked.
6. **Result wording:** should the business owner's own wording for a result section win over Sieve's generated
   wording? (That's the one failing test.)

## Smaller notes (fine for now)

- Login and upload limits are kept in the server's memory. That's fine while Sieve runs as one server. If it ever
  runs as several, they'd need to be shared.
- On sign-up, Sieve says when an email already has an account. That's normal and friendlier, but it does let someone
  check whether an email is registered. Login and reset don't reveal this.

/* Sieve embed. Paste on any website:
 *
 *   Inline (grows to fit, no scrollbars):
 *     <div data-sieve="your-scorecard-slug"></div>
 *     <script src="https://sieve.com.ng/embed.js" async></script>
 *
 *   Popup button:
 *     <button data-sieve-popup="your-scorecard-slug">Take the quiz</button>
 *     <script src="https://sieve.com.ng/embed.js" async></script>
 */
(function () {
  if (window.__sieveEmbed) return;
  window.__sieveEmbed = true;
  var me = document.currentScript || document.querySelector('script[src*="/embed.js"]');
  var origin = (me && me.src) ? new URL(me.src).origin : 'https://sieve.com.ng';
  var safe = function (s) { return encodeURIComponent(String(s || '').trim()); };
  var frames = [];

  function makeFrame(slug, extra) {
    var f = document.createElement('iframe');
    f.src = origin + '/take/index.html?slug=' + safe(slug) + '&embed=1' + (extra || '');
    f.title = 'Scorecard';
    f.loading = 'lazy';
    f.allow = 'clipboard-write';
    f.style.cssText = 'width:100%;border:0;display:block;min-height:560px;background:transparent;';
    frames.push(f);
    return f;
  }

  function mountInline(el) {
    if (el.__sieve) return; el.__sieve = true;
    el.appendChild(makeFrame(el.getAttribute('data-sieve')));
  }

  function openPopup(slug) {
    var wrap = document.createElement('div');
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(10,12,26,.6);display:flex;align-items:center;justify-content:center;padding:16px;';
    var box = document.createElement('div');
    box.style.cssText = 'position:relative;width:100%;max-width:760px;max-height:92vh;overflow:auto;background:#F7F9FD;border-radius:20px;box-shadow:0 30px 80px rgba(0,0,0,.35);';
    var close = document.createElement('button');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '×';
    close.style.cssText = 'position:absolute;top:8px;right:10px;z-index:2;width:36px;height:36px;border-radius:50%;border:0;background:#fff;font:700 22px/1 sans-serif;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.15);';
    var frame = makeFrame(slug);
    frame.loading = 'eager';
    box.appendChild(close); box.appendChild(frame); wrap.appendChild(box);
    var prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    function shut() { wrap.remove(); document.body.style.overflow = prevOverflow; frames = frames.filter(function (x) { return x !== frame; }); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') shut(); }
    close.onclick = shut;
    wrap.addEventListener('click', function (e) { if (e.target === wrap) shut(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(wrap);
    close.focus();
  }

  function scan() {
    document.querySelectorAll('[data-sieve]').forEach(mountInline);
    document.querySelectorAll('[data-sieve-popup]').forEach(function (b) {
      if (b.__sieve) return; b.__sieve = true;
      b.addEventListener('click', function (e) { e.preventDefault(); openPopup(b.getAttribute('data-sieve-popup')); });
    });
  }

  // the quiz page tells us its height so the frame grows to fit
  window.addEventListener('message', function (e) {
    if (e.origin !== origin || !e.data || e.data.type !== 'sieve:height') return;
    frames.forEach(function (f) {
      if (f.contentWindow === e.source) f.style.height = Math.max(320, Math.min(20000, Number(e.data.height) || 0)) + 'px';
    });
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan); else scan();
})();

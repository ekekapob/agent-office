// Error reporter (ADR-0008): toasts with time, message, copy and dismiss (max 5),
// footer counter, global error / unhandledrejection handlers, `#err=test` self-test,
// and wrap() for guarded loops. Ported from the mockup's showErr().

const MAX_TOASTS = 5;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Install the reporter. Elements may be null (headless); reporting then only logs.
 * @param {{errbar?:HTMLElement|null, diag?:HTMLElement|null, win?:Window}} refs
 * @returns {{report:(msg:string, detail?:string)=>void, wrap:<T extends Function>(fn:T, label?:string)=>T, count:()=>number, list:()=>Array<{when:Date,msg:string,detail?:string}>}}
 */
export function installErrorReporter({ errbar = null, diag = null, win = typeof window !== 'undefined' ? window : null } = {}) {
  const errors = [];

  function refreshDiag() {
    if (!diag) return;
    const n = errors.length;
    diag.textContent = n ? `🩺 ${n} error${n > 1 ? 's' : ''}` : '🩺 no errors';
    diag.classList.toggle('bad', n > 0);
  }
  /**
   * Show one error toast and count it.
   * @param {string} msg
   * @param {string} [detail]
   */
  function report(msg, detail) {
    const when = new Date();
    errors.push({ when, msg: String(msg), detail: detail ? String(detail) : undefined });
    console.error('[agent-deck]', msg, detail || '');
    refreshDiag();
    if (!errbar || typeof document === 'undefined') return;
    try {
      errbar.hidden = false;
      const d = document.createElement('div');
      d.className = 'err';
      d.innerHTML = `<span class="t">${when.toTimeString().slice(0, 8)}</span><span class="m">⚠ ${esc(msg)}${detail ? `<br><span class="d">${esc(detail)}</span>` : ''}</span><button title="copy">copy</button><button title="dismiss">✕</button>`;
      const [copyBtn, closeBtn] = d.querySelectorAll('button');
      copyBtn.onclick = () => {
        const text = `${when.toISOString()} ${msg}${detail ? ' — ' + detail : ''}`;
        if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
        copyBtn.textContent = 'copied';
      };
      closeBtn.onclick = () => { d.remove(); if (!errbar.children.length) errbar.hidden = true; };
      errbar.prepend(d);
      while (errbar.children.length > MAX_TOASTS) errbar.lastChild.remove();
    } catch (err) { console.error('[agent-deck] toast failed', err); }
  }
  /**
   * Wrap a function so exceptions are reported (first 3 per wrapper as toasts,
   * the rest to the console) instead of escaping. Returns undefined on failure.
   * @template {Function} T
   * @param {T} fn @param {string} [label]
   * @returns {T}
   */
  function wrap(fn, label = fn && fn.name || 'callback') {
    let n = 0;
    return /** @type {any} */ (function wrapped(...args) {
      try { return fn.apply(this, args); } catch (err) {
        n++;
        const where = (err && err.stack || '').split('\n')[1] || '';
        if (n <= 3) report(`${label}: ${err && err.message ? err.message : err}`, where.trim());
        else console.error('[agent-deck]', label, err);
        return undefined;
      }
    });
  }
  if (diag) diag.onclick = () => { if (!errors.length) { diag.textContent = '🩺 no errors so far'; return; } if (errbar) errbar.hidden = !errbar.hidden; };
  if (win) {
    win.addEventListener('error', (e) => report(e.message || 'script error', `${(e.filename || '').split('/').pop()}:${e.lineno}:${e.colno}`));
    win.addEventListener('unhandledrejection', (e) => report('unhandled promise rejection', String(e.reason && e.reason.message || e.reason)));
    if (/err=test/.test(win.location && win.location.hash || '')) setTimeout(() => { throw new Error('test error from #err=test — the reporter works'); }, 1500);
  }
  refreshDiag();
  return { report, wrap, count: () => errors.length, list: () => errors.slice() };
}

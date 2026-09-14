// SSE client for /events with reconnect + backoff. Applies every event to the store
// and keeps ui.streamStatus current (live / reconnecting / disconnected).
/** @typedef {import('./store.js').createStore} createStore */

const TYPES = ['snapshot', 'session', 'session_removed', 'agent', 'agent_removed', 'feed', 'huddle', 'huddle_removed', 'alert', 'alert_cleared', 'error', 'health'];
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000, 30000];
const STALE_MS = 75000; // heartbeat snapshots arrive every 30 s

/**
 * Connect to the event stream.
 * @param {string} url
 * @param {ReturnType<createStore>} store
 * @param {{onStatus?:(s:{state:string,lastEventAt:number,attempt:number})=>void, onError?:(msg:string, detail?:string)=>void, EventSourceImpl?:typeof EventSource}} [opts]
 * @returns {{close:()=>void}}
 */
export function connect(url, store, opts = {}) {
  const ES = opts.EventSourceImpl || (typeof EventSource !== 'undefined' ? EventSource : null);
  const onStatus = opts.onStatus || (() => {}), onError = opts.onError || (() => {});
  let es = null, attempt = 0, timer = null, staleTimer = null, closed = false, lastEventAt = 0;

  function status(state) {
    const s = { state, lastEventAt, attempt };
    try { store.setUI({ streamStatus: { state, lastEventAt } }); } catch (err) { console.error('[stream] setUI failed', err); }
    try { onStatus(s); } catch (err) { console.error('[stream] onStatus failed', err); }
  }
  if (!ES) { onError('EventSource is not available in this browser'); status('disconnected'); return { close() { closed = true; } }; }

  function handle(type, e) {
    lastEventAt = Date.now();
    if (attempt) { attempt = 0; status('live'); } else store.setUI({ streamStatus: { lastEventAt } });
    let data;
    try { data = JSON.parse(e.data); } catch (err) { onError(`bad ${type} event from the server`, String(e.data).slice(0, 120)); return; }
    if (type === 'error' && data && data.msg) onError(data.msg, data.detail);
    if (!store.apply({ type, data })) onError(`could not apply ${type} event`, JSON.stringify(data).slice(0, 120));
  }
  function open() {
    if (closed) return;
    try { es = new ES(url); } catch (err) { onError('could not open the event stream', err && err.message); schedule(); return; }
    for (const t of TYPES) es.addEventListener(t, (e) => handle(t, e));
    es.onopen = () => { lastEventAt = Date.now(); attempt = 0; status('live'); };
    es.onerror = () => { // the browser retries on its own, but our own backoff gives predictable status
      if (closed) return;
      try { es.close(); } catch (_) { /* ignore */ }
      es = null;
      schedule();
    };
  }
  function schedule() {
    if (closed || timer) return;
    attempt++;
    status(attempt >= 3 ? 'disconnected' : 'reconnecting');
    const wait = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)];
    timer = setTimeout(() => { timer = null; open(); }, wait);
  }
  staleTimer = setInterval(() => { // silent stream → treat as lost and reconnect
    if (closed || !es || !lastEventAt || Date.now() - lastEventAt < STALE_MS) return;
    onError('no events for ' + Math.round((Date.now() - lastEventAt) / 1000) + ' s, reconnecting');
    try { es.close(); } catch (_) { /* ignore */ }
    es = null;
    schedule();
  }, 5000);
  status('reconnecting');
  open();
  return {
    close() {
      closed = true;
      clearTimeout(timer); clearInterval(staleTimer); timer = null;
      if (es) { try { es.close(); } catch (_) { /* ignore */ } es = null; }
      status('disconnected');
    },
  };
}

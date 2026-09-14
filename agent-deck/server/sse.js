// server/sse.js — GET /events. A full Snapshot on connect, deltas after, and another Snapshot every 30 s
// as a heartbeat so a client that missed a delta repairs itself (CONTRACTS §4).
// The source is anything with `on(fn)` and `snapshot()`: the live state in normal mode, the demo player in --demo.

const HEARTBEAT_MS = 30000;
const MAX_CLIENTS = 32;

/**
 * @typedef {Object} SseHub
 * @property {(req:import('node:http').IncomingMessage, res:import('node:http').ServerResponse)=>void} handle
 * @property {()=>number} count
 * @property {()=>void} close
 */

/**
 * @param {{source:{on:(fn:(ev:{type:string,data:any})=>void)=>()=>void, snapshot:()=>Object}, log:Object,
 *          heartbeatMs?:number}} opts
 * @returns {SseHub}
 */
export function createSse(opts) {
  const { source, log } = opts;
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  /** @type {Set<{res:import('node:http').ServerResponse, id:number}>} */
  const clients = new Set();
  let seq = 0;
  let closed = false;

  const unsubscribe = source.on((ev) => broadcast(ev.type, ev.data));
  const beat = setInterval(() => {
    if (!clients.size) return;
    let snap;
    try { snap = source.snapshot(); } catch (e) { log.error('snapshot for heartbeat failed', e); return; }
    broadcast('snapshot', snap);
  }, heartbeatMs);
  if (typeof beat.unref === 'function') beat.unref();

  /** @param {string} type @param {any} data */
  function broadcast(type, data) {
    if (!clients.size || closed) return;
    const frame = format(type, data);
    if (!frame) return;
    for (const c of [...clients]) write(c, frame);
  }

  function format(type, data) {
    let json;
    try { json = JSON.stringify(data); } catch (e) { log.warn(`cannot serialise a ${type} event`, e); return null; }
    return `event: ${type}\ndata: ${json}\n\n`;
  }

  function write(c, frame) {
    try { c.res.write(frame); }
    catch (e) { log.debug(`client ${c.id} write failed`, e); drop(c); }
  }

  function drop(c) {
    if (!clients.delete(c)) return;
    try { c.res.end(); } catch { /* already gone */ }
  }

  /** Serve one /events request. */
  function handle(req, res) {
    if (clients.size >= MAX_CLIENTS) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('too many event streams open\n');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const c = { res, id: ++seq };
    clients.add(c);
    res.write('retry: 2000\n\n');
    let snap = null;
    try { snap = source.snapshot(); } catch (e) { log.error('snapshot on connect failed', e); }
    if (snap) write(c, format('snapshot', snap));
    log.debug(`event stream ${c.id} open (${clients.size} client${clients.size === 1 ? '' : 's'})`);
    const done = () => { log.debug(`event stream ${c.id} closed`); drop(c); };
    req.on('close', done);
    req.on('error', done);
    res.on('error', done);
  }

  function close() {
    closed = true;
    clearInterval(beat);
    try { unsubscribe(); } catch { /* ignore */ }
    for (const c of [...clients]) drop(c);
  }

  return { handle, count: () => clients.size, close };
}

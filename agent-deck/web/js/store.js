// Store: the Snapshot from the server plus UI state. apply() takes StreamEvents
// (CONTRACTS §4); subscribers are told after every change with (state, event).
/** @typedef {import('../../shared/types.js').Snapshot} Snapshot */
/** @typedef {import('../../shared/types.js').StreamEvent} StreamEvent */
/**
 * @typedef {Object} UIState
 * @property {string|null} sessionId
 * @property {string|null} selectedId
 * @property {string|null} hoverId
 * @property {string|null} focusRoomId
 * @property {string} theme
 * @property {{state:'live'|'reconnecting'|'disconnected', lastEventAt:number}} streamStatus
 */

const FEED_CAP = 500;
const ERR_CAP = 20;

function emptyHealth() {
  return { version: '', dataRoot: '', mode: 'native', sessions: 0, agents: 0, hooksSeen: false, lastErrors: [], drift: [] };
}
/** @returns {Snapshot} */
function emptyState() {
  return { now: 0, sessions: {}, agents: {}, huddles: {}, alerts: {}, feed: [], health: emptyHealth() };
}
function asMap(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }

/**
 * Create the client store.
 * @returns {{getState:()=>Snapshot, apply:(ev:StreamEvent)=>boolean, subscribe:(fn:(state:Snapshot, ev:Object|null)=>void)=>()=>void, getUI:()=>UIState, setUI:(patch:Partial<UIState>)=>void}}
 */
export function createStore() {
  let state = emptyState();
  /** @type {UIState} */
  let ui = { sessionId: null, selectedId: null, hoverId: null, focusRoomId: 'deck', theme: 'spaceship', streamStatus: { state: 'disconnected', lastEventAt: 0 } };
  const subs = new Set();

  function notify(ev) {
    for (const fn of subs) { try { fn(state, ev); } catch (err) { console.error('[store] subscriber failed', err); } }
  }
  function upsert(coll, item) {
    if (!item || typeof item.id !== 'string') return false;
    state[coll] = { ...state[coll], [item.id]: item };
    return true;
  }
  function remove(coll, data) {
    const id = data && data.id;
    if (typeof id !== 'string' || !(id in state[coll])) return false;
    const next = { ...state[coll] }; delete next[id]; state[coll] = next;
    return true;
  }
  function pushFeed(item) {
    if (!item || typeof item !== 'object') return false;
    const feed = [item, ...state.feed];
    if (feed.length > FEED_CAP * 2) {
      const perSession = {};
      state.feed = feed.filter((f) => { const k = f.sessionId || ''; perSession[k] = (perSession[k] || 0) + 1; return perSession[k] <= FEED_CAP; });
    } else state.feed = feed;
    return true;
  }

  /**
   * Apply one stream event. Unknown or malformed events are ignored (returns false), never thrown.
   * @param {StreamEvent|{type:string,data:any}} ev
   */
  function apply(ev) {
    if (!ev || typeof ev.type !== 'string') return false;
    const d = ev.data;
    let ok = true;
    switch (ev.type) {
      case 'snapshot': {
        if (!d || typeof d !== 'object') return false;
        state = { now: typeof d.now === 'number' ? d.now : Date.now(), sessions: asMap(d.sessions), agents: asMap(d.agents), huddles: asMap(d.huddles), alerts: asMap(d.alerts), feed: Array.isArray(d.feed) ? d.feed.slice(0, FEED_CAP * 4) : [], health: { ...emptyHealth(), ...asMap(d.health) } };
        break;
      }
      case 'session': ok = upsert('sessions', d); break;
      case 'session_removed': {
        ok = remove('sessions', d);
        if (ok) { // a vanished session takes its agents, huddles and alerts with it
          for (const coll of ['agents', 'huddles', 'alerts']) {
            const next = {}; let changed = false;
            for (const [k, v] of Object.entries(state[coll])) { if (v && v.sessionId === d.id) changed = true; else next[k] = v; }
            if (changed) state[coll] = next;
          }
        }
        break;
      }
      case 'agent': ok = upsert('agents', d); break;
      case 'agent_removed': ok = remove('agents', d); break;
      case 'huddle': ok = upsert('huddles', d); break;
      case 'huddle_removed': ok = remove('huddles', d); break;
      case 'alert': ok = upsert('alerts', d); break;
      case 'alert_cleared': ok = remove('alerts', d); break;
      case 'feed': ok = pushFeed(d); break;
      case 'health': if (!d || typeof d !== 'object') return false; state.health = { ...emptyHealth(), ...d }; break;
      case 'error': {
        if (!d || typeof d.msg !== 'string') return false;
        const last = [{ when: typeof d.when === 'number' ? d.when : Date.now(), msg: d.msg, detail: d.detail }, ...(state.health.lastErrors || [])].slice(0, ERR_CAP);
        state.health = { ...state.health, lastErrors: last };
        break;
      }
      default: return false;
    }
    if (!ok) return false;
    state = { ...state };
    notify(ev);
    return true;
  }

  /** Subscribe to changes; returns an unsubscribe function. */
  function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }
  /** Merge a patch into the UI state (streamStatus is merged one level deeper). */
  function setUI(patch) {
    if (!patch || typeof patch !== 'object') return;
    const next = { ...ui, ...patch };
    if (patch.streamStatus) next.streamStatus = { ...ui.streamStatus, ...patch.streamStatus };
    ui = next;
    notify({ type: 'ui', data: patch });
  }
  return { getState: () => state, apply, subscribe, getUI: () => ui, setUI };
}

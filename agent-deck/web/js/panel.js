// Agent Deck — right panel (owner D). Renders the whole #panel column for the selected session.
// Pure HTML string building; the only DOM side effects are container.innerHTML and one delegated click handler.
/** @typedef {import('../../shared/types.js').Snapshot} Snapshot */
/** @typedef {import('../../shared/types.js').Session} Session */
/** @typedef {import('../../shared/types.js').Agent} Agent */
/** @typedef {import('../../shared/types.js').Huddle} Huddle */
/** @typedef {import('../../shared/types.js').Alert} Alert */
/** @typedef {import('../../shared/types.js').FeedItem} FeedItem */

export const ICON = {Grep:'🔍',Read:'📖',Bash:'💻',Edit:'✏️',Write:'📝',Agent:'🧬',Glob:'🗂️',WebFetch:'🌐'};
const STATE_LABEL = {working:'working',thinking:'thinking',waiting:'needs approval',idle:'idle',done:'finished',joining:'joining',leaving:'leaving',compacting:'compacting context',teleporting:'beaming to deck'};
const TYPE_LABEL = {lead:'Session lead',Explore:'Explore subagent',Plan:'Plan subagent','general-purpose':'General subagent','code-review':'Review subagent'};
const STATUS_COLOR = {busy:'working',waiting:'waiting',idle:'idle',stale:'waiting',unreadable:'compacting'};
const CTX_WARN = 85, CTX_COMPACT = 96;

/** @param {unknown} s @returns {string} HTML-escaped text */
export function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
/** @param {number} t epoch ms @returns {string} "12s" · "4m" · "1h 05m" */
export function ago(t){let d=Math.max(0,Date.now()-(+t||0))/1000;if(d<60)return Math.floor(d)+'s';if(d<3600)return Math.floor(d/60)+'m';return Math.floor(d/3600)+'h '+String(Math.floor(d%3600/60)).padStart(2,'0')+'m'}
/** Elapsed-time span that tickAgo() keeps fresh. @param {number} t epoch ms */
export function agoSpan(t){return `<span data-ago="${+t||0}">${ago(t)}</span>`}
/** @param {number} t epoch ms @returns {string} HH:MM local */
export function hhmm(t){const d=new Date(+t||0);return isNaN(d)?'—':d.toTimeString().slice(0,5)}
/** @param {number} n @returns {string} 1.20M · 148k · 42 */
export function fmtTok(n){n=+n||0;return n>=1e6?(n/1e6).toFixed(2)+'M':n>=1e3?Math.round(n/1e3)+'k':String(n)}
/** @param {string} type Agent.type @returns {string} human label */
export function typeLabel(type){return TYPE_LABEL[type]||(type?esc(type)+' subagent':'agent')}
/** @param {string} state @returns {string} human label */
export function stateLabel(state){return STATE_LABEL[state]||esc(state||'')}
/** @param {object} theme @param {string} state @returns {string} colour */
export function stateColor(theme,state){return (theme&&theme.states&&theme.states[state])||{working:'#3ddc97',thinking:'#6aa6ff',waiting:'#ffb347',idle:'#7f8ba6',done:'#b48cff',joining:'#b48cff',leaving:'#b48cff',compacting:'#ff4d4d',teleporting:'#7fe7ff'}[state]||'#7f8ba6'}
/** Model chip `<i class="chip">`. @param {object} theme @param {string|null} model */
export function chipHTML(theme,model){const m=(theme&&theme.models&&theme.models[model])||{chip:model?shortModel(model):'?',color:'#7f8ba6'};return `<i class="chip" style="background:${esc(m.color)}" title="${esc(model||'')}">${esc(m.chip)}</i>`}
function shortModel(m){const x=/(fable|opus|sonnet|haiku)[^\d]*(\d+)(?:[-.](\d))?/.exec(m);return x?x[1][0].toUpperCase()+x[2]+(x[3]?'.'+x[3]:''):'?'}
/** Context use in percent (0–100). @param {{ctxUsed?:number,ctxLimit?:number}} a */
export function ctxPct(a){return a&&a.ctxLimit>0?Math.min(100,Math.max(0,a.ctxUsed/a.ctxLimit*100)):0}
/** Short display name for pod seats ("Explore · hooks" → "hooks"). @param {string} name */
export function shortName(name){return String(name||'').replace(/^(Scout|Explore) · /,'')}

/** Agents of one session, lead first then by spawn time. @param {Snapshot} state @param {string} sid @returns {Agent[]} */
export function sessionAgents(state,sid){return Object.values(state.agents||{}).filter(a=>a&&a.sessionId===sid).sort((x,y)=>(y.isLead?1:0)-(x.isLead?1:0)||(x.spawnedAt||0)-(y.spawnedAt||0))}
/** Huddles of one session ordered by start. @param {Snapshot} state @param {string} sid @returns {Huddle[]} */
export function sessionHuddles(state,sid){return Object.values(state.huddles||{}).filter(h=>h&&h.sessionId===sid).sort((x,y)=>(x.startedAt||0)-(y.startedAt||0))}
/** 1-based huddle number inside its session (H1, H2…). @param {Snapshot} state @param {string} hid */
export function huddleNumber(state,hid){const h=(state.huddles||{})[hid];if(!h)return 0;return sessionHuddles(state,h.sessionId).findIndex(x=>x.id===hid)+1}

/**
 * Files "on the table" of a huddle: paths touched by ≥2 agents of the session, at least one a member.
 * @param {Snapshot} state @param {Huddle} huddle
 * @returns {Array<{path:string,agents:Array<{name:string,huddleId:string|null}>,editors:number,conflict:boolean,otherHuddles:string[]}>}
 */
export function sharedFiles(state,huddle){
  if(!huddle)return[];const map={},ids=new Set(huddle.memberIds||[]);
  for(const a of sessionAgents(state,huddle.sessionId)){if(!a.touched)continue;
    for(const [pth,t] of Object.entries(a.touched)){const f=map[pth]=map[pth]||{path:pth,agents:[],editors:0,hasMember:false,other:new Set()};
      f.agents.push({name:shortName(a.name),huddleId:a.huddleId||null});if(t&&t.edit)f.editors++;if(ids.has(a.id))f.hasMember=true;if(a.huddleId&&a.huddleId!==huddle.id)f.other.add(a.huddleId)}}
  return Object.values(map).filter(f=>f.hasMember&&f.agents.length>=2).map(f=>({path:f.path,agents:f.agents,editors:f.editors,conflict:f.editors>=2,otherHuddles:[...f.other]}))
    .sort((x,y)=>(y.conflict-x.conflict)||(y.agents.length-x.agents.length)).slice(0,4);
}
/** Paths edited by agents of two different huddles. @param {Snapshot} state @param {string} sid @returns {Array<{path:string,huddleIds:string[]}>} */
export function crossConflicts(state,sid){const map={};for(const a of sessionAgents(state,sid)){if(!a.huddleId||!a.touched)continue;for(const [pth,t] of Object.entries(a.touched)){if(!t||!t.edit)continue;(map[pth]=map[pth]||new Set()).add(a.huddleId)}}
  return Object.entries(map).filter(([,s])=>s.size>=2).map(([path,s])=>({path,huddleIds:[...s]}))}

/**
 * Bubble content for a state. Used by the canvas bubbles and the card's "Now" line.
 * @param {{state:string,tool?:string|null,text?:string|null,since?:number,ctxPct?:number,huddleN?:number}} b
 * @returns {string} HTML
 */
export function bubbleHTML(b){
  const tool=b.tool?`<b>${esc(b.tool)}</b> `:'',text=b.text?`<code>${esc(b.text)}</code>`:'';
  switch(b.state){
    case 'working':return `${ICON[b.tool]||'⚙️'} ${tool}${text||'working'}`;
    case 'thinking':return `💭 ${b.text?esc(b.text):'thinking'}…`;
    case 'waiting':return `✋ ${tool}${text} · approve?`;
    case 'idle':return `☕ idle ${agoSpan(b.since||Date.now())}`;
    case 'done':return `✅ ${b.text?esc(b.text):'finished'}`;
    case 'leaving':return `👋 done · leaving`;
    case 'joining':return b.huddleN?`🚪 joining huddle ${b.huddleN}`:`🚪 ${b.text?esc(b.text):'joining'}`;
    case 'teleporting':return `✨ beaming to the deck`;
    case 'compacting':return `🗜 compacting context · ${Math.round(b.ctxPct||0)}%`;
    default:return esc(b.text||b.state||'');
  }
}

const dot=c=>`<span class="dot" style="background:${esc(c)}"></span>`;
function row(inner,{first=false,click=null,on=false}={}){return `<div class="row${first?' first':''}${click?' click':''}${on?' on':''}"${click?` data-select="${esc(click)}"`:''}>${inner}</div>`}
function feedIcon(e){if(e.kind==='prompt')return '🧑‍💻';if(e.kind==='spawn')return '🧬';if(e.kind==='end')return '✅';if(e.kind==='compact')return '🗜';return ICON[e.tool]||'•'}
function evHTML(e){return `<div class="ev${e.kind==='prompt'?' you':''}"><span class="t">${hhmm(e.t)}</span><span>${feedIcon(e)}</span><span><span class="w">${esc(e.who)}</span> ${e.tool?`<b>${esc(e.tool)}</b> <code>${esc(e.text)}</code>`:esc(e.text)}</span></div>`}

function attentionCard(state,s,agents,huddles,theme,opts){
  const warn=opts.ctxWarn??CTX_WARN,compact=opts.ctxCompact??CTX_COMPACT,rows=[];
  const alerts=Object.values(state.alerts||{}).filter(a=>a&&a.sessionId===s.id).sort((x,y)=>(x.since||0)-(y.since||0));
  const waiting=agents.filter(a=>a.state==='waiting');
  for(const a of waiting)rows.push(row(`${dot(stateColor(theme,'waiting'))}<div class="grow"><b>${esc(a.name)}</b> · ${esc(a.tool||'permission')} <code>${esc(a.args||'')}</code><div class="muted">waiting ${agoSpan(a.since)} · approve in the session terminal</div></div><button class="btn" data-select="${esc(a.id)}">Show</button>`));
  for(const al of alerts.filter(x=>x.kind==='approval'&&!waiting.some(w=>w.id===x.agentId)))rows.push(row(`${dot(stateColor(theme,'waiting'))}<div class="grow"><b>${esc(agentName(state,al.agentId)||'Session')}</b> · ${esc(al.text)}<div class="muted">since ${agoSpan(al.since)}</div></div>${al.agentId?`<button class="btn" data-select="${esc(al.agentId)}">Show</button>`:''}`));
  const lead=agents.find(a=>a.isLead),lp=lead?ctxPct(lead):ctxPct(s);
  if(lead&&(lp>=warn||lead.state==='compacting'))rows.push(row(`${dot('#ff4d4d')}<div class="grow"><b>${esc(lead.name)}</b> · ${lead.state==='compacting'?'compacting context now':`context ${Math.round(lp)}% · auto-compact expected at ~${compact}%`}<div class="muted">what is not in memory or files may be summarised away</div></div><button class="btn" data-select="${esc(lead.id)}">Show</button>`));
  for(const al of alerts.filter(x=>x.kind==='context'&&x.agentId!==(lead&&lead.id)))rows.push(row(`${dot('#ff4d4d')}<div class="grow"><b>${esc(agentName(state,al.agentId)||'Agent')}</b> · ${esc(al.text)}</div>${al.agentId?`<button class="btn" data-select="${esc(al.agentId)}">Show</button>`:''}`));
  const seen=new Set();
  for(const c of crossConflicts(state,s.id)){seen.add(c.path);const ns=c.huddleIds.map(h=>'huddle '+huddleNumber(state,h)).join(' and ');rows.push(row(`${dot('#ff4d4d')}<div class="grow"><b><code>${esc(c.path)}</code></b> is being edited in ${ns}<div class="muted">two batches changing the same file</div></div>`))}
  for(const al of alerts.filter(x=>x.kind==='conflict'&&!seen.has(x.detail&&x.detail.path)))rows.push(row(`${dot('#ff4d4d')}<div class="grow">${esc(al.text)}<div class="muted">since ${agoSpan(al.since)}</div></div>`));
  if(s.status==='stale')rows.push(row(`${dot('#ffb347')}<div class="grow"><b>Stale</b> · no file change since ${agoSpan(s.updatedAt)}${s.liveness===false?' · process not seen':''}<div class="muted">the picture may be out of date</div></div>`));
  for(const al of alerts.filter(x=>x.kind==='stale'))rows.push(row(`${dot('#ffb347')}<div class="grow">${esc(al.text)}<div class="muted">since ${agoSpan(al.since)}</div></div>`));
  if(s.status==='unreadable')rows.push(row(`${dot('#ff4d4d')}<div class="grow"><b>Unreadable</b> · the transcript could not be parsed<div class="muted">other sessions continue · see the footer error log</div></div>`));
  for(const al of alerts.filter(x=>x.kind==='drift'))rows.push(row(`${dot('#b48cff')}<div class="grow"><b>Format changed</b> · ${esc(al.text)}<div class="muted">some details may be missing until the adapter is updated</div></div>`));
  if(!rows.length)return '';
  rows[0]=rows[0].replace('class="row','class="row first');
  return `<div class="card attn"><h3>✋ Needs your attention</h3>${rows.join('')}</div>`;
}
function agentName(state,id){const a=id&&(state.agents||{})[id];return a?a.name:null}

function sessionCard(s,lead,theme,opts){
  const pct=lead?ctxPct(lead):ctxPct(s),hot=pct>=(opts.ctxWarn??CTX_WARN),tk=s.tokens||{};
  const badge=s.status==='unreadable'?' <span class="badge">UNREADABLE</span>':s.status==='stale'?' <span class="badge stale">STALE</span>':'';
  return `<div class="card"><h3>${dot(stateColor(theme,STATUS_COLOR[s.status]||'idle'))}${esc(s.name)}${badge}</h3>
  <dl class="kv"><dt>Status</dt><dd>${esc(s.status)}${s.liveness===false?' · process gone':''}</dd><dt>Directory</dt><dd title="${esc(s.cwd)}">${esc(s.cwd)}</dd><dt>Branch</dt><dd>${esc(s.branch||'—')}</dd><dt>PID</dt><dd>${s.pid??'—'}</dd><dt>Uptime</dt><dd>${agoSpan(s.startedAt)}</dd><dt>Model</dt><dd>${esc(s.model||'—')}${s.effort?` <span class="muted">· effort ${esc(s.effort)}</span>`:''}</dd><dt>Version</dt><dd>${esc(s.version||'—')}</dd><dt>Turns</dt><dd>${s.turns??0}</dd><dt>Tokens</dt><dd>${fmtTok(tk.input)} in · ${fmtTok(tk.output)} out · ${fmtTok(tk.cacheRead)} cached</dd></dl>
  <div class="bar" style="margin-top:10px"><i class="${hot?'hot':''}" style="width:${pct.toFixed(1)}%"></i></div><div class="muted small${hot?' hot':''}" style="margin-top:4px">Context window ${Math.round(pct)}% of ${fmtTok((lead||s).ctxLimit)}${hot?' · compaction soon':''}</div></div>`;
}
function memberRow(state,a,theme,sel){return row(`${dot(stateColor(theme,a.state))}<div class="grow"><b>${esc(a.name)}</b>${chipHTML(theme,a.model)} <span class="muted">· ${esc(a.brief||typeLabel(a.type))}</span><div class="muted">${stateLabel(a.state)}${a.tool&&(a.state==='working'||a.state==='waiting')?' · '+esc(a.tool)+' <code>'+esc(a.args||'')+'</code>':''}</div></div>`,{click:a.id,on:sel===a.id})}
function huddleCard(state,h,theme,sel){
  const n=huddleNumber(state,h.id),ms=(h.memberIds||[]).map(id=>state.agents[id]).filter(Boolean),sf=sharedFiles(state,h),size=(h.memberIds||[]).length;
  const status=h.status==='closed'?'closed':(h.reports>=size&&size>0?'all reports in':'in session');
  return `<div class="card hud"><h3 class="click" data-room="${esc(h.id)}" title="Fly to this pod">🛸 Huddle ${n} <span class="muted small">· ${status} · ${agoSpan(h.startedAt)}</span></h3><p class="prompt">“${esc(h.goal)}”</p>
  ${ms.map((a,k)=>memberRow(state,a,theme,sel).replace('class="row','class="row'+(k===0?' first':''))).join('')||'<div class="muted small">no members yet</div>'}
  <div class="muted small" style="margin-top:8px">reports back ${h.reports||0}/${size} · on the table: ${sf.length?sf.map(f=>(f.conflict?'⚠ ':'')+'<code>'+esc(f.path)+'</code>'+(f.otherHuddles.length?' ⟨'+f.otherHuddles.map(x=>'H'+huddleNumber(state,x)).join(',')+'⟩':'')).join(', '):'nothing shared yet'}</div></div>`;
}
function crewCard(state,agents,theme,sel){
  return `<div class="card"><h3>👥 On the deck (${agents.length})</h3>${agents.map((a,k)=>{const where=a.huddleId?' · huddle '+huddleNumber(state,a.huddleId):(a.isLead?'':' · deck');
    return row(`${dot(stateColor(theme,a.state))}<div class="grow"><b>${esc(a.name)}</b>${chipHTML(theme,a.model)} <span class="muted">· ${typeLabel(a.type)}${where}</span><div class="muted">${stateLabel(a.state)}${a.tool&&(a.state==='working'||a.state==='waiting')?' · '+esc(a.tool)+' <code>'+esc(a.args||'')+'</code>':''} · ${agoSpan(a.since)}</div></div>`,{first:k===0,click:a.id,on:sel===a.id})}).join('')||'<div class="muted small">nobody here yet</div>'}</div>`;
}
function feedCard(state,s,sel){
  const a=sel?state.agents[sel]:null;
  const items=(state.feed||[]).filter(e=>e&&e.sessionId===s.id&&(!a||e.agentId===a.id||e.kind==='prompt')).slice(0,20);
  return `<div class="card"><h3>🕒 Activity ${a?`<span class="muted small">· ${esc(a.name)} only</span><button class="btn right" data-select="">show all</button>`:''}</h3><div class="feed">${items.map(evHTML).join('')||'<div class="muted small">nothing yet</div>'}</div></div>`;
}
const HOWTO=`<div class="card"><h3>How to read the deck</h3><ul class="src">
  <li>Room = one session from <code>~/.claude/sessions/&lt;pid&gt;.json</code></li>
  <li>Big desk = session lead; other desks = subagents from the <code>subagents/</code> folder</li>
  <li>Bubble = latest <code>tool_use</code> in that agent's transcript</li>
  <li>Airlock = a subagent starting or finishing</li>
  <li>Glass pod = several <code>Agent</code> calls in one lead turn; the holo sign is that turn's question; pods alternate sides of the hallway, newest furthest out</li>
  <li>On the table = paths two or more agents touched; ⟨H2⟩ marks another huddle; ⚠ when two agents edit the same file</li>
  <li>Transporter = a pod collapsing when its last report is in; the crew beams to the deck and leaves by the airlock</li>
  <li>Raised hand = waiting for your approval</li>
  <li>Whiteboard = last user prompt · rack = transcript log · red triangle = context over 85%</li></ul></div>`;

/**
 * Render the right panel for `ui.sessionId` into `container`.
 * @param {HTMLElement} container the #panel element
 * @param {Snapshot} state
 * @param {{sessionId?:string|null,selectedId?:string|null}} ui
 * @param {{theme?:object,onSelect?:(id:string|null)=>void,onFocusRoom?:(id:string)=>void,ctxWarn?:number,ctxCompact?:number}} opts
 */
export function renderPanel(container,state,ui,opts={}){
  if(!container)return;const theme=opts.theme||{};
  try{
    container.classList.add('deck-panel');
    const sessions=(state&&state.sessions)||{},sid=(ui&&ui.sessionId)||Object.keys(sessions)[0]||null,s=sid?sessions[sid]:null;
    let html;
    if(!s){html=`<div class="card empty">${Object.keys(sessions).length?'Pick a session in the top bar.':'No Claude Code sessions found yet. Start one and it will appear here.'}</div>${HOWTO}`}
    else{const agents=sessionAgents(state,s.id),huddles=sessionHuddles(state,s.id),lead=agents.find(a=>a.isLead),sel=(ui&&ui.selectedId)||null;
      html=attentionCard(state,s,agents,huddles,theme,opts)+sessionCard(s,lead,theme,opts)
        +`<div class="card"><h3>📌 Current assignment</h3><p class="prompt">${s.lastPrompt?'“'+esc(s.lastPrompt)+'”':'<span class="muted">no prompt seen yet</span>'}</p></div>`
        +huddles.map(h=>huddleCard(state,h,theme,sel)).join('')+crewCard(state,agents,theme,sel)+feedCard(state,s,sel)+HOWTO}
    const top=container.scrollTop;container.innerHTML=html;container.scrollTop=top;
  }catch(err){container.innerHTML=`<div class="card attn"><h3>Panel error</h3><div class="muted small">${esc(err&&err.message)}</div></div>`;console.warn('renderPanel',err)}
  container.onclick=e=>{const t=e.target instanceof Element?e.target:null;if(!t)return;
    const sel=t.closest('[data-select]');if(sel){e.stopPropagation();if(opts.onSelect)opts.onSelect(sel.getAttribute('data-select')||null);return}
    const room=t.closest('[data-room]');if(room){e.stopPropagation();if(opts.onFocusRoom)opts.onFocusRoom(room.getAttribute('data-room'))}};
}

/**
 * Refresh every `<span data-ago="ms">` under `root`. Call once a second.
 * @param {ParentNode} root
 */
export function tickAgo(root){if(!root||!root.querySelectorAll)return;for(const el of root.querySelectorAll('[data-ago]')){const v=ago(+el.getAttribute('data-ago'));if(el.textContent!==v)el.textContent=v}}

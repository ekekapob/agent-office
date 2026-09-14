// Agent Deck — HTML overlays above the canvas (owner D): speech bubbles, name plates with model/CTX chips,
// pod goal signs and table chips, and the hover/pinned info card with a live portrait.
// Everything is placed with renderer.project() so it works with any renderer that implements the interface.
/** @typedef {import('../../shared/types.js').Snapshot} Snapshot */
/** @typedef {import('../../shared/types.js').Agent} Agent */
import {esc,agoSpan,hhmm,fmtTok,typeLabel,stateLabel,stateColor,chipHTML,ctxPct,shortName,sessionAgents,huddleNumber,sharedFiles,bubbleHTML,tickAgo} from './panel.js';

const HEAD_STAND=26,HEAD_SEAT=22;                                  // art px from the feet to the top of the head
const LIFT={waiting:15,idle:13};                                   // extra bubble lift per state (default 5)
const CTX_WARN=85,CTX_COMPACT=96,HIDE_DELAY=450;

/**
 * Mount the overlay layer.
 * @param {{container:HTMLElement,renderer:{project:Function,portrait?:Function},theme?:object,store?:object,onSelect?:(id:string)=>void,onHover?:(id:string|null)=>void,ctxWarn?:number,ctxCompact?:number}} o
 *   container is the #ov layer (absolute, pointer-events none). onSelect(id) fires on a click on a bubble or plate;
 *   the card pins when the next update() sees ui.selectedId === id. onHover(id|null) mirrors DOM hover.
 * @returns {{update:(scene:object,state:Snapshot,ui:object)=>void,setZoomScale:(zs:number)=>void,destroy:()=>void}}
 */
export function createOverlays({container,renderer,theme,store,onSelect,onHover,ctxWarn=CTX_WARN,ctxCompact=CTX_COMPACT}){
  const people=new Map(),pods=new Map();                          // id → {bub,nm,sig} · id → {holo,tcard,sig}
  let scene=null,state=null,ui={},hoverId=null,extHover=null,cardFor=null,cardHover=false,hideTimer=null,destroyed=false;
  const hcard=document.createElement('div');hcard.className='hcard';hcard.hidden=true;document.body.append(hcard);
  hcard.addEventListener('mouseenter',()=>{cardHover=true;clearTimeout(hideTimer)});
  hcard.addEventListener('mouseleave',()=>{cardHover=false;scheduleCard()});
  for(const ev of ['mousedown','pointerdown','wheel'])hcard.addEventListener(ev,e=>e.stopPropagation(),{passive:true});
  const onResize=()=>{if(!hcard.hidden&&cardFor)positionCard(cardFor)};
  window.addEventListener('resize',onResize);window.addEventListener('scroll',onResize,true);

  const agentOf=id=>(state&&state.agents&&state.agents[id])||null;
  const personOf=id=>scene?(scene.people||[]).find(p=>p.id===id)||null:null;
  const selectedId=()=>(ui&&ui.selectedId!==undefined?ui.selectedId:(scene&&scene.hilite?scene.hilite.selectedId:null))||null;
  const project=pt=>{try{return renderer.project(pt)}catch(_){return null}};
  const px=v=>Math.round(v)+'px';

  function setHover(id){if(hoverId===id)return;hoverId=id;if(onHover)onHover(id);scheduleCard()}
  function scheduleCard(){clearTimeout(hideTimer);hideTimer=setTimeout(updateCard,HIDE_DELAY)}
  function bubbleFor(person,agent){const b=person.bubble||{};const st=b.kind||person.state;
    return bubbleHTML({state:st,tool:b.tool??(agent&&agent.tool),text:b.text??(agent&&agent.args),since:agent?agent.since:0,ctxPct:agent?ctxPct(agent):0,huddleN:st==='joining'&&agent&&agent.huddleId?podN(agent.huddleId):0})}
  function podN(hid){const p=scene&&(scene.pods||[]).find(x=>x.id===hid);return p?p.n:(state?huddleNumber(state,hid):0)}

  function ensurePerson(id){let e=people.get(id);if(e)return e;
    const bub=document.createElement('div'),nm=document.createElement('div');bub.className='bub';nm.className='nm';
    for(const el of [bub,nm]){el.addEventListener('click',ev=>{ev.stopPropagation();if(onSelect)onSelect(id)});
      el.addEventListener('mouseenter',()=>setHover(id));el.addEventListener('mouseleave',()=>setHover(null));
      for(const t of ['mousedown','pointerdown'])el.addEventListener(t,ev=>ev.stopPropagation())}
    container.append(bub,nm);e={bub,nm,sig:''};people.set(id,e);return e}
  function ensurePod(id){let e=pods.get(id);if(e)return e;
    const holo=document.createElement('div'),tcard=document.createElement('div');holo.className='holo';tcard.className='tcard';
    for(const el of [holo,tcard])for(const t of ['mousedown','pointerdown','click'])el.addEventListener(t,ev=>ev.stopPropagation());
    container.append(holo,tcard);e={holo,tcard,sig:''};pods.set(id,e);return e}

  function renderPerson(e,person,agent,sel){
    const st=person.state,pct=agent?ctxPct(agent):0,warn=person.ctxWarn||pct>=ctxWarn;
    const b=person.bubble||{};
    const sig=[st,b.kind,b.tool,b.text,person.name,person.model,warn?Math.round(pct):0,sel,person.seated,agent&&agent.since].join('');
    if(sig===e.sig)return;e.sig=sig;
    e.bub.className='bub '+esc(st)+(sel?' sel':'');e.bub.style.setProperty('--sc',stateColor(theme,st));e.bub.innerHTML=bubbleFor(person,agent);
    const inPod=!!(agent&&agent.huddleId),name=inPod&&person.seated?shortName(person.name):person.name;
    e.nm.className='nm'+(person.seated?'':' walk');
    e.nm.innerHTML=esc(name)+chipHTML(theme,person.model||(agent&&agent.model))+(warn&&st!=='compacting'?`<i class="chip warn">CTX ${Math.round(pct)}%</i>`:'');
  }
  function placePerson(e,person,k){
    const pos=person.pos||{i:0,j:0},head=(person.seated?HEAD_SEAT:HEAD_STAND)+(LIFT[person.state]||5);
    const bp=project({i:pos.i,j:pos.j,z:head});if(bp){e.bub.style.left=px(bp.x);e.bub.style.top=px(bp.y)}
    const pl=person.plate&&Number.isFinite(person.plate.i)?person.plate:{i:pos.i,j:pos.j,z:-6-(k%2)*9};
    const np=project({i:pl.i,j:pl.j,z:pl.z||0});if(np){e.nm.style.left=px(np.x);e.nm.style.top=px(np.y)}
    const a=person.alpha==null?1:Math.max(0,Math.min(1,person.alpha));
    e.bub.style.opacity=e.nm.style.opacity=String(a);e.bub.style.display=e.nm.style.display=a<=0.02?'none':'';
  }
  function renderPod(e,pod){
    const h=state&&state.huddles&&state.huddles[pod.id];const shared=h?sharedFiles(state,h):[];
    const sig=JSON.stringify([pod.n,pod.goal,pod.reports,pod.size,pod.h<1,shared,h&&h.status]);if(sig===e.sig)return;e.sig=sig;
    e.holo.innerHTML=`<span class="t">H${+pod.n||0} GOAL</span>${esc(pod.goal||(h&&h.goal)||'')}`;
    const size=pod.size??(h?h.memberIds.length:0),reports=pod.reports??(h?h.reports:0),nConf=shared.filter(f=>f.conflict).length;
    const closing=h&&h.status==='closed';
    e.tcard.innerHTML=`<div class="tc-line">📋 <b>huddle ${+pod.n||0}</b> · ${reports}/${size} reports · ${shared.length?`<span class="${nConf?'bad':''}">${nConf?'⚠ ':''}${shared.length} shared file${shared.length>1?'s':''}</span>`:'no shared files'}${closing?' · beaming out':''}</div>`
      +`<div class="full"><div class="tc-h">${size} agents${h?' · '+agoSpan(h.startedAt):''}</div><div class="tc-sub">on the table</div>`
      +(shared.length?shared.map(f=>`<div class="tc-f ${f.conflict?'bad':''}">${f.conflict?'⚠':'📄'} <code>${esc(f.path)}</code> <span class="muted">${f.conflict?'edited by ':''}${f.agents.map(x=>esc(x.name)+(x.huddleId&&x.huddleId!==pod.id?`<span class="oth">⟨H${podN(x.huddleId)}⟩</span>`:'')).join(' + ')}</span></div>`).join(''):'<div class="tc-f muted">nothing shared yet</div>')
      +`<div class="tc-r">reports back: <b>${reports}</b> of ${size}</div></div>`;
  }
  function placePod(e,pod){
    const t=pod.tableAt||{i:0,j:0},h=Math.max(0,Math.min(1,pod.h==null?1:pod.h)),zo=-30*(1-h);
    const gp=project({i:t.i,j:t.j-0.2,z:30+zo});if(gp){e.holo.style.left=px(gp.x);e.holo.style.top=px(gp.y)}
    const tp=project({i:t.i+0.1,j:t.j+1.55,z:zo});if(tp){e.tcard.style.left=px(tp.x);e.tcard.style.top=px(tp.y)}
    e.holo.style.opacity=e.tcard.style.opacity=String(h);e.holo.style.display=e.tcard.style.display=h<=0.02?'none':'';
  }

  /* ---- hover / pinned card ---- */
  function updateCard(){
    if(destroyed)return;
    const id=selectedId()||hoverId||extHover||(cardHover?cardFor:null);
    const a=id?agentOf(id):null,p=id?personOf(id):null;
    if(!a&&!p){hcard.hidden=true;hcard.classList.remove('pinned');cardFor=null;return}   // drop the pinned mark with the card, or a later hover reopens looking pinned
    const fresh=cardFor!==id||hcard.hidden;                         // anchor once when it opens; do not follow the person afterwards
    if(cardFor!==id){cardFor=id;renderCard(id)}
    hcard.classList.toggle('pinned',selectedId()===id);hcard.hidden=false;
    if(fresh)positionCard(id);
  }
  function crewSummary(a){const subs=sessionAgents(state,a.sessionId).filter(x=>!x.isLead);
    const active=subs.filter(x=>['working','thinking','waiting','joining'].includes(x.state)).length,fin=subs.filter(x=>x.state==='done'||x.state==='leaving').length;
    return `${subs.length} spawned · ${active} active · ${fin} finished`}
  function renderCard(id){
    const a=agentOf(id),p=personOf(id)||{};const s=a&&state.sessions?state.sessions[a.sessionId]:null;
    const name=(a&&a.name)||p.name||id,model=(a&&a.model)||p.model||null,type=(a&&a.type)||p.type||'agent',st=(a&&a.state)||p.state||'idle',lead=a?a.isLead:!!p.isLead;
    const tk=(a&&a.tokens)||{},tools=Object.entries((a&&a.toolCounts)||{}).sort((x,y)=>y[1]-x[1]),calls=tools.reduce((n,[,c])=>n+c,0);
    const pct=a?ctxPct(a):0,hot=pct>=ctxWarn,cacheTot=(tk.input||0)+(tk.cacheRead||0),cachePct=cacheTot>0?Math.round((tk.cacheRead||0)/cacheTot*100):0;
    const hn=a&&a.huddleId?podN(a.huddleId):0,hud=a&&a.huddleId&&state.huddles?state.huddles[a.huddleId]:null;
    const parent=a&&a.parentId&&state.agents[a.parentId]?state.agents[a.parentId].name:'Lead';
    const now=a?bubbleHTML({state:st,tool:p.bubble?p.bubble.tool:a.tool,text:p.bubble?p.bubble.text:a.args,since:a.since,ctxPct:pct,huddleN:hn}):bubbleFor(p,null);
    hcard.innerHTML=`
 <div class="hc-head"><canvas class="hc-port" width="84" height="120"></canvas>
  <div class="hc-title"><div class="hc-name">${esc(name)}${chipHTML(theme,model)}</div>
   <div class="hc-type">${typeLabel(type)}${hn?' · huddle '+hn:(lead?'':' · deck')}</div>
   <div class="hc-state"><span class="dot" style="background:${esc(stateColor(theme,st))}"></span>${stateLabel(st)}${a?' · '+agoSpan(a.since):''}</div>
   <dl class="hc-kv"><dt>Model</dt><dd>${esc(model||'—')}<span class="muted"> · effort ${esc((a&&a.effort)||'—')}</span></dd><dt>Now</dt><dd class="bub-inline">${now}</dd></dl></div></div>
 ${st==='waiting'?`<div class="hc-wait">✋ WAITING ${a?agoSpan(a.since):''} · ${esc((a&&a.tool)||'permission')} <code>${esc((a&&a.args)||'')}</code><span class="muted">approve in the session terminal</span></div>`:''}
 ${a?`<div class="hc-sec"><dl class="hc-kv">
  <dt>${lead?'Prompt':'Brief'}</dt><dd>${lead?(s&&s.lastPrompt?'“'+esc(s.lastPrompt)+'”':'—'):esc(a.brief||'—')}</dd>
  <dt>Tools</dt><dd>${tools.map(([t,c])=>`${esc(t)} ${c}`).join(' · ')||'—'}<span class="muted"> · ${calls} calls</span></dd>
  <dt>Tokens</dt><dd>in ${fmtTok(tk.input)} · out ${fmtTok(tk.output)} · thinking ${fmtTok(tk.thinking)}</dd>
  <dt>Cache</dt><dd>${fmtTok(tk.cacheRead)} read (${cachePct}%) · ${fmtTok(tk.cacheWrite)} written</dd>
  <dt>Context</dt><dd><div class="hc-bar"><i class="${hot?'hot':''}" style="width:${pct.toFixed(1)}%"></i></div><span class="${hot?'hc-hot':'muted'}">${Math.round(pct)}% of ${fmtTok(a.ctxLimit)}${lead?' · auto-compact at ~'+ctxCompact+'%':''}</span></dd></dl></div>
 <div class="hc-sec"><dl class="hc-kv">
  ${lead?`<dt>Turn</dt><dd>${s?s.turns:'—'}</dd><dt>Crew</dt><dd>${crewSummary(a)}</dd><dt>Session</dt><dd>pid ${s&&s.pid!=null?s.pid:'—'} · started ${hhmm(s?s.startedAt:a.spawnedAt)} · ${esc(s?s.cwd:'')}</dd>`
       :`<dt>Spawned</dt><dd>${hhmm(a.spawnedAt||a.since)} by ${esc(parent)}${hud?' · together with '+Math.max(0,hud.memberIds.length-1)+' more (huddle '+hn+')':''}</dd>`}
  <dt>Log</dt><dd><code>${esc(a.transcriptPath||'')}</code></dd></dl></div>`:''}
 <div class="hc-foot">${selectedId()===id?'pinned · click the person again or press Esc to close':'hover to peek · click to pin'}</div>`;
  }
  function positionCard(id){
    const p=personOf(id);if(!p)return;const pos=p.pos||{i:0,j:0};
    const head=project({i:pos.i,j:pos.j,z:(p.seated?HEAD_SEAT:HEAD_STAND)});if(!head)return;
    const r=container.getBoundingClientRect(),cw=hcard.offsetWidth,ch=hcard.offsetHeight,vw=window.innerWidth,vh=window.innerHeight;
    let left=r.left+head.x+36,top=r.top+head.y-16;
    if(left+cw>vw-8)left=r.left+head.x-36-cw;                        // flip to the left of the person
    if(left<8)left=8;if(top+ch>vh-8)top=vh-ch-8;if(top<8)top=8;       // keep inside the window, not the frame
    hcard.style.left=px(left);hcard.style.top=px(top);
  }
  function drawPortrait(){
    if(hcard.hidden||!cardFor||!renderer.portrait)return;const pc=hcard.querySelector('.hc-port'),p=personOf(cardFor);if(!pc||!p)return;
    try{renderer.portrait(pc.getContext('2d'),p,performance.now())}catch(_){}
  }
  function hostCard(){const stage=container.parentElement;if(!stage)return;
    const full=document.fullscreenElement===stage||stage.classList.contains('max');const host=full?stage:document.body;if(hcard.parentElement!==host)host.append(hcard)}

  /**
   * Place and refresh every overlay for this frame. Cheap when nothing changed: text is re-rendered only on change.
   * @param {object} sc Scene @param {Snapshot} st @param {{selectedId?:string|null,hoverId?:string|null}} u
   */
  function update(sc,st,u){
    if(destroyed)return;
    try{
      const prevSel=selectedId();scene=sc||scene;state=st||(store&&store.getState?store.getState():state);ui=u||ui;
      const sel=selectedId(),seen=new Set(),seenPods=new Set();
      (scene&&scene.people||[]).forEach((person,k)=>{if(!person||!person.id)return;seen.add(person.id);const e=ensurePerson(person.id);renderPerson(e,person,agentOf(person.id),sel===person.id);placePerson(e,person,k)});
      for(const [id,e] of people)if(!seen.has(id)){e.bub.remove();e.nm.remove();people.delete(id)}
      for(const pod of (scene&&scene.pods||[])){if(!pod||!pod.id)continue;seenPods.add(pod.id);const e=ensurePod(pod.id);renderPod(e,pod);placePod(e,pod)}
      for(const [id,e] of pods)if(!seenPods.has(id)){e.holo.remove();e.tcard.remove();pods.delete(id)}
      const eh=(ui&&ui.hoverId!==undefined?ui.hoverId:(scene&&scene.hilite?scene.hilite.hoverId:null))||null;
      if(eh!==extHover){extHover=eh;scheduleCard()}
      if(sel!==prevSel){clearTimeout(hideTimer);if(cardFor)renderCard(cardFor);updateCard()}
      else if(!hcard.hidden&&cardFor&&!agentOf(cardFor)&&!personOf(cardFor))updateCard();
      hostCard();drawPortrait();if(!hcard.hidden)tickAgo(hcard);
    }catch(err){console.warn('overlays.update',err)}
  }
  /** @param {number} zs zoom relative to the fitted zoom; clamped to 0.7–1.35 */
  function setZoomScale(zs){const v=Math.max(0.7,Math.min(1.35,+zs||1));container.style.setProperty('--zs',v.toFixed(2))}
  function destroy(){destroyed=true;clearTimeout(hideTimer);window.removeEventListener('resize',onResize);window.removeEventListener('scroll',onResize,true);
    for(const e of people.values()){e.bub.remove();e.nm.remove()}for(const e of pods.values()){e.holo.remove();e.tcard.remove()}people.clear();pods.clear();hcard.remove()}
  return {update,setZoomScale,destroy};
}

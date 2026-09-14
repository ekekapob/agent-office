// Agent Deck — drop-up rooms list (owner D). Renders into #podlist: header pinned at the bottom,
// rows stacked upward with the deck row nearest the header, one row per pod. Click a row to fly there.
/** @typedef {import('../../shared/types.js').Snapshot} Snapshot */

function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
const FALLBACK={working:'#3ddc97',joining:'#b48cff',teleporting:'#7fe7ff',trim:'#19d3e6'};

/**
 * Create the rooms list inside `container` (the #podlist element).
 * @param {HTMLElement} container
 * @param {{onFocus?:(id:string)=>void,theme?:object}} opts  onFocus receives 'deck' or a pod id (= huddle id)
 * @returns {{update:(state:Snapshot,scene:object,ui:object)=>void,destroy:()=>void}}
 */
export function createRoomsList(container,{onFocus,theme}={}){
  let collapsed=false,sig='',prevH=new Map(),falling=new Set(),lastArgs=null;
  const stop=e=>e.stopPropagation();
  if(container){container.classList.add('podlist');
    container.addEventListener('wheel',stop,{passive:true});       // scroll the list, never zoom the stage
    container.addEventListener('mousedown',stop);container.addEventListener('pointerdown',stop);container.addEventListener('touchstart',stop,{passive:true});
    container.addEventListener('click',e=>{const t=e.target instanceof Element?e.target:null;if(!t)return;e.stopPropagation();
      if(t.closest('.h')){collapsed=!collapsed;sig='';if(lastArgs)update(...lastArgs);return}
      const r=t.closest('[data-room]');if(r&&onFocus)onFocus(r.getAttribute('data-room'))})}
  const col=k=>(theme&&theme.states&&theme.states[k])||(theme&&theme.palette&&theme.palette[k])||FALLBACK[k];

  function rowsFor(state,scene,ui){
    const sessions=(state&&state.sessions)||{},agents=(state&&state.agents)||{},huddles=(state&&state.huddles)||{};
    const sid=(ui&&ui.sessionId)||null,s=sid?sessions[sid]:null;
    const pods=(scene&&scene.pods)||[],people=(scene&&scene.people)||[];
    const podIds=new Set(pods.map(p=>p.id));
    const onDeck=people.filter(p=>{const a=agents[p.id];return !(a&&a.huddleId&&podIds.has(a.huddleId))&&p.state!=='teleporting'}).length;
    const rows=[{id:'deck',label:'Deck · '+(s?s.name:'—'),meta:`${onDeck} on deck`,color:col('trim'),dim:false}];
    for(const p of pods){const h=huddles[p.id]||{},ph=prevH.get(p.id);
      if(ph!==undefined&&p.h<ph-1e-6)falling.add(p.id);else if(ph!==undefined&&p.h>ph+1e-6)falling.delete(p.id);prevH.set(p.id,p.h);
      const down=falling.has(p.id)||h.status==='closed';
      const members=(h.memberIds||[]).filter(id=>agents[id]).length;
      const size=p.size??(h.memberIds||[]).length,reports=p.reports??h.reports??0;
      rows.push({id:p.id,label:`H${p.n} · ${p.goal||h.goal||''}`,meta:`${members} agent${members===1?'':'s'} · ${reports}/${size}`,color:down?col('teleporting'):(p.h<1?col('joining'):col('working')),dim:down&&p.h<1})}
    for(const id of [...prevH.keys()])if(!podIds.has(id)){prevH.delete(id);falling.delete(id)}
    return rows;
  }

  /**
   * Re-render when anything visible changed. Safe to call every frame.
   * @param {Snapshot} state @param {object} scene @param {{sessionId?:string,focusRoomId?:string}} ui
   */
  function update(state,scene,ui){
    if(!container)return;lastArgs=[state,scene,ui];
    try{
      const rows=rowsFor(state,scene,ui),focus=(ui&&ui.focusRoomId)||'deck',n=rows.length-1;
      const s=JSON.stringify([collapsed,focus,rows]);if(s===sig)return;sig=s;
      container.classList.toggle('collapsed',collapsed);
      container.innerHTML=rows.slice().reverse().map(r=>`<div class="row2${focus===r.id?' on':''}${r.dim?' dim':''}" data-room="${esc(r.id)}" title="${esc(r.label)}"><span class="dot" style="background:${esc(r.color)}"></span><span class="g">${esc(r.label)}</span><span class="m">${esc(r.meta)}</span></div>`).join('')
        +`<div class="h" title="${collapsed?'Open the rooms list':'Collapse the rooms list'}">${collapsed?'▴':'▾'} Rooms <span class="n">${n} huddle${n===1?'':'s'}${collapsed?'':' · click to fly there'}</span></div>`;
      if(!collapsed)container.scrollTop=container.scrollHeight;
    }catch(err){console.warn('rooms.update',err)}
  }
  return {update,destroy(){if(container){container.innerHTML='';container.classList.remove('podlist','collapsed')}}};
}

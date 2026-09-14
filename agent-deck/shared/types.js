// Shared JSDoc typedefs for Agent Deck. No runtime code. Import for documentation: /** @typedef {import('../shared/types.js').Session} Session */

/**
 * @typedef {'working'|'thinking'|'waiting'|'idle'|'done'|'joining'|'leaving'|'compacting'} AgentState
 * @typedef {'busy'|'idle'|'waiting'|'stale'|'unreadable'} SessionStatus
 */

/**
 * @typedef {Object} Tokens
 * @property {number} input
 * @property {number} output
 * @property {number} thinking
 * @property {number} cacheRead
 * @property {number} cacheWrite
 */

/**
 * @typedef {Object} Session
 * @property {string} id            Claude Code sessionId (UUID). Stable across resume.
 * @property {number|null} pid      Current process id from the registry, if known.
 * @property {string} name          Display name (registry `name`, else ai-title, else cwd basename).
 * @property {string} cwd
 * @property {string|null} branch
 * @property {number} startedAt     epoch ms
 * @property {number} updatedAt     epoch ms of the last file change we saw
 * @property {SessionStatus} status      derived: what the dashboard shows
 * @property {SessionStatus} [regStatus]  what Claude Code's own registry file says
 * @property {string|null} [waitingFor]   registry reason, e.g. "dialog open"
 * @property {string|null} version  Claude Code version
 * @property {string|null} model    latest assistant model
 * @property {string|null} effort
 * @property {number} ctxUsed       tokens in the latest turn's input (see CONTRACTS §3)
 * @property {number} ctxLimit
 * @property {Tokens} tokens        cumulative for the lead
 * @property {number} turns
 * @property {string|null} lastPrompt
 * @property {string} transcriptPath
 * @property {boolean} liveness     true when pid alive (native) or files fresh (docker)
 * @property {boolean} [unreadable]   transcript still missing 30 s after the session appeared
 */

/**
 * @typedef {Object} Agent
 * @property {string} id            "<sessionId>" for the lead, "<sessionId>/<agentId>" for subagents
 * @property {string} sessionId
 * @property {string|null} parentId agent id that spawned it (lead for depth 1)
 * @property {boolean} isLead
 * @property {string} type          "lead" | subagent_type ("Explore", "Plan", "general-purpose", ...)
 * @property {string} name          description from the Agent call, else type
 * @property {string|null} model
 * @property {string|null} effort
 * @property {AgentState} state
 * @property {string|null} tool     current tool name
 * @property {string|null} args     short argument summary (≤120 chars)
 * @property {string[]} paths       paths touched by the current tool call
 * @property {string|null} brief    the Agent call's prompt
 * @property {Tokens} tokens
 * @property {number} ctxUsed
 * @property {number} ctxLimit
 * @property {Object<string,number>} toolCounts
 * @property {number} since         epoch ms the current state began
 * @property {number} spawnedAt
 * @property {string|null} huddleId
 * @property {string} transcriptPath
 * @property {Object<string,{edit:boolean,n:number}>} touched  path → touch summary
 */

/**
 * @typedef {Object} Huddle
 * @property {string} id            "<sessionId>/<assistantMessageId>"
 * @property {string} sessionId
 * @property {string} goal
 * @property {string[]} memberIds
 * @property {number} startedAt
 * @property {number} reports       members that have finished
 * @property {'open'|'closed'} status
 */

/**
 * @typedef {Object} Alert
 * @property {string} id
 * @property {'approval'|'context'|'conflict'|'drift'|'stale'} kind
 * @property {string} sessionId
 * @property {string|null} agentId
 * @property {string} text
 * @property {number} since
 * @property {Object} [detail]
 */

/**
 * @typedef {Object} FeedItem
 * @property {string} id
 * @property {string} sessionId
 * @property {string|null} agentId
 * @property {number} t
 * @property {'prompt'|'tool'|'spawn'|'end'|'compact'|'note'} kind
 * @property {string} who
 * @property {string|null} tool
 * @property {string} text
 */

/**
 * @typedef {Object} Health
 * @property {string} version        Agent Deck version
 * @property {string} dataRoot
 * @property {'native'|'docker'} mode
 * @property {number} sessions
 * @property {number} agents
 * @property {boolean} hooksSeen     a hook POST has arrived since start
 * @property {Array<{when:number,msg:string,detail?:string}>} lastErrors
 * @property {Array<{field:string,version:string,sample:string}>} drift
 */

/**
 * @typedef {Object} Snapshot
 * @property {number} now
 * @property {Object<string,Session>} sessions
 * @property {Object<string,Agent>} agents
 * @property {Object<string,Huddle>} huddles
 * @property {Object<string,Alert>} alerts
 * @property {FeedItem[]} feed       newest first, capped (500 per session)
 * @property {Health} health
 */

/**
 * @typedef {{type:'session',data:Session}|{type:'session_removed',data:{id:string}}|{type:'agent',data:Agent}|{type:'agent_removed',data:{id:string}}|{type:'feed',data:FeedItem}|{type:'huddle',data:Huddle}|{type:'huddle_removed',data:{id:string}}|{type:'alert',data:Alert}|{type:'alert_cleared',data:{id:string}}|{type:'error',data:{when:number,msg:string,detail?:string}}|{type:'health',data:Health}|{type:'snapshot',data:Snapshot}} StreamEvent
 */

/**
 * Adapter events: output of shared/adapter.js (pure). Consumed by server/state.js.
 * @typedef {{kind:'session_meta',sessionId:string,name?:string,cwd?:string,branch?:string,version?:string,t:number}
 *  |{kind:'prompt',sessionId:string,agentId:string|null,text:string,t:number}
 *  |{kind:'assistant_turn',sessionId:string,agentId:string|null,messageId:string,model:string|null,effort:string|null,usage:Tokens,ctxUsed:number,text:string|null,stopReason:string|null,t:number}
 *  |{kind:'tool_call',sessionId:string,agentId:string|null,messageId:string,toolUseId:string,tool:string,input:Object,args:string,paths:string[],isEdit:boolean,t:number}
 *  |{kind:'tool_result',sessionId:string,agentId:string|null,toolUseId:string,ok:boolean,t:number}
 *  |{kind:'agent_spawn',sessionId:string,toolUseId:string,agentId:string,parentAgentId:string|null,type:string,description:string,brief:string,model:string|null,t:number}
 *  |{kind:'agent_end',sessionId:string,agentId:string,t:number}
 *  |{kind:'compaction',sessionId:string,t:number}
 *  |{kind:'title',sessionId:string,title:string,t:number}
 *  |{kind:'drift',sessionId:string|null,field:string,version:string|null,sample:string,repeat?:number}} AdapterEvent
 */

export {};

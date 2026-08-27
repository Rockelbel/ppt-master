const fallbackSeed = [
  {id:'p1',title:'制造业客户的三个共性挑战',type:'问题',tags:['首次拜访','制造业'],page:2},
  {id:'p2',title:'从人工经验到流程自动化',type:'洞察',tags:['降本','自动化'],page:4},
  {id:'p3',title:'一套方案，覆盖关键交付节点',type:'方案',tags:['产品能力','流程'],page:6},
  {id:'p4',title:'某汽车零部件客户案例',type:'案例',tags:['行业案例','汽车'],page:8},
  {id:'p5',title:'交付周期缩短 42%',type:'数据',tags:['数据','效率'],page:9},
  {id:'p6',title:'从今天开始的三步行动',type:'行动召唤',tags:['下一步','复盘'],page:12}
];
const PAGE_STORAGE='lego-pages-v3';
const importedPages=JSON.parse(localStorage.getItem(PAGE_STORAGE)||'null');
const savedPageMap=new Map(Array.isArray(importedPages)?importedPages.map(page=>[page.id,page]):[]);
const mergeSavedPage=(page,saved)=>{
  if(!saved)return {...page};
  const merged={...page,...saved};
  // Re-indexed XML titles should replace stale automatic values; keep explicit manual edits.
  if(saved.titleSource!=='manual'){merged.title=page.title;merged.titleSource=page.titleSource;}
  // Server-side AI results are canonical; do not let an older browser cache hide them.
  if(String(page.annotationSource||'').startsWith('deepseek')||page.reviewStatus==='ai-pending'){
    for(const field of ['description','structureTags','sceneTags','tags','scenarios','pageType','annotationSource','reviewStatus','aiLabeling','libraryStatus','libraryStatusReason']){
      if(field in page)merged[field]=page[field];
    }
  }
  return merged;
};
let pages=[...fallbackSeed];
let libraryItems=[];
const libraryState={page:1,pageSize:12,total:0,totalPages:1,counts:{},facets:{},loaded:false,loading:false,requestId:0};
let librarySearchTimer=null;
let imports=JSON.parse(localStorage.getItem('lego-imports')||'[]');
let importPollTimer=null;
const REWRITE_TASK_STORAGE='ppt-customer-rewrite-tasks-v1';
let customerRewriteTasks=JSON.parse(localStorage.getItem(REWRITE_TASK_STORAGE)||'[]');
let customerRewritePollTimer=null;
const DRAFT_STORAGE='lego-preview-v1';
let draft=JSON.parse(localStorage.getItem(DRAFT_STORAGE)||'null')||[];
let previewSessionId='';
let previewSessionVersion=0;
let previewSessionReady=false;
let previewBootstrapPromise=null;
let previewSyncChain=Promise.resolve();
let active=null;
let previewIndex=0;
const STRUCTURE_ENUM=['封面','目录','内容','尾页'];
const BASE_SCENE_ENUM=['公司介绍','产品介绍','商旅','机票','酒店','火车','用车','用餐','费控','报销','AI','Agent','管控','合规','降本','SLA','MICE','发票','支付','客户案例','流程','数据','服务'];
const ANNOTATION_STATUS_ENUM=[['all','全部'],['pending','待标注'],['processing','标注中'],['review','待确认'],['confirmed','已确认']];
const CUSTOM_TAG_STORAGE='lego-custom-tags-v1';
let CUSTOM_TAGS=JSON.parse(localStorage.getItem(CUSTOM_TAG_STORAGE)||'[]').filter(Boolean);
let SCENE_ENUM=[...new Set([...BASE_SCENE_ENUM,...CUSTOM_TAGS])];
const activeFilters={structure:new Set(),scene:new Set(),status:'all'};
let previewDockExpanded=false;
let pendingExportIds=[];
const AI_SESSION_STORAGE='ppt-ai-sessions-v1';
let aiSessions=JSON.parse(localStorage.getItem(AI_SESSION_STORAGE)||'[]');
let activeAiSessionId=localStorage.getItem('ppt-ai-active-session')||'';
let contextMenuPageId='';
const $=s=>document.querySelector(s);
const save=()=>{pages.forEach(page=>savedPageMap.set(page.id,page));localStorage.setItem(PAGE_STORAGE,JSON.stringify([...savedPageMap.values()]));localStorage.setItem('lego-imports',JSON.stringify(imports));localStorage.setItem(DRAFT_STORAGE,JSON.stringify(draft));localStorage.setItem(REWRITE_TASK_STORAGE,JSON.stringify(customerRewriteTasks));};
function mergePageRecords(records=[]){
  for(const page of records){
    if(!page?.id)continue;
    const merged=mergeSavedPage(page,savedPageMap.get(page.id));
    const index=pages.findIndex(item=>item.id===page.id);
    if(index<0)pages.push(merged);else pages[index]=merged;
  }
}
async function fetchPageRecords(ids=[]){
  const requested=[...new Set(ids.filter(Boolean).filter(id=>!pages.some(page=>page.id===id)))];
  if(!requested.length)return;
  const response=await fetch(`/api/pages?ids=${encodeURIComponent(requested.join(','))}`);
  if(!response.ok)throw new Error('页面数据加载失败');
  const payload=await response.json();
  mergePageRecords(payload.items||[]);
}
async function loadLibraryPage(pageNumber=1){
  const requestId=++libraryState.requestId;
  libraryState.loading=true;
  const params=new URLSearchParams({page:String(pageNumber),pageSize:String(libraryState.pageSize),query:$('#search')?.value||'',structure:[...activeFilters.structure].join(','),scene:[...activeFilters.scene].join(','),status:activeFilters.status});
  try{
    const response=await fetch(`/api/pages?${params.toString()}`);
    if(!response.ok)throw new Error(`资源库加载失败（${response.status}）`);
    const payload=await response.json();
    if(requestId!==libraryState.requestId)return;
    mergePageRecords(payload.items||[]);
    libraryItems=(payload.items||[]).filter(isLibraryVisible);
    Object.assign(libraryState,{page:payload.page||pageNumber,pageSize:payload.pageSize||libraryState.pageSize,total:payload.total||0,totalPages:payload.totalPages||1,counts:payload.counts||{},facets:payload.facets||{},loaded:true,loading:false});
    const facetScenes=[...(libraryState.facets.scene||[]),...CUSTOM_TAGS];
    SCENE_ENUM=[...new Set([...BASE_SCENE_ENUM,...facetScenes])];
    renderFilterPanel();renderLibrary($('#search')?.value||'');
  }catch(error){
    libraryState.loading=false;
    if(!libraryState.loaded){libraryItems=libraryPages();renderFilterPanel();renderLibrary($('#search')?.value||'');}
    console.warn(error.message);
  }
}
function applyPreviewSessionPayload(payload){
  const session=payload?.session||payload;
  if(!session||!Array.isArray(session.pageIds))return;
  previewSessionId=session.sessionId||session.id||previewSessionId;
  previewSessionVersion=Number(session.version||0);
  previewSessionReady=true;
  const nextIds=[...session.pageIds];
  draft=nextIds.filter(id=>pages.some(page=>page.id===id));
  const missing=nextIds.filter(id=>!pages.some(page=>page.id===id));
  if(missing.length)fetchPageRecords(missing).then(()=>{draft=nextIds.filter(id=>pages.some(page=>page.id===id));save();renderPreviewDock();renderDraft();updateAiTaskContext();}).catch(error=>console.warn(error.message));
  save();
}
async function bootstrapPreviewSession(){
  const sessionId=activeAiSessionId;
  if(!sessionId)return;
  if(previewBootstrapPromise)return previewBootstrapPromise;
  previewBootstrapPromise=(async()=>{
    try{
      const response=await fetch(`/api/preview/sessions/${encodeURIComponent(sessionId)}?draftIds=${encodeURIComponent(draft.join(','))}`);
      if(!response.ok)throw new Error(await response.text()||'预览队列同步失败');
      const payload=await response.json();applyPreviewSessionPayload(payload.session);previewSessionId=sessionId;
      renderPreviewDock();renderDraft();renderLibrary($('#search')?.value||'');updateAiTaskContext();
    }catch(error){console.warn('Preview session bootstrap failed:',error.message);}
    finally{previewBootstrapPromise=null;}
  })();
  return previewBootstrapPromise;
}
function persistPreviewOperation(operation){
  const sessionId=activeAiSessionId;
  if(!sessionId)return;
  previewSyncChain=previewSyncChain.then(async()=>{
    if(!previewSessionReady)await bootstrapPreviewSession();
    if(!previewSessionReady)return;
    try{
      const response=await fetch(`/api/preview/sessions/${encodeURIComponent(sessionId)}/operations`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation,expectedVersion:previewSessionVersion,source:'ui',initialPageIds:[...draft]})});
      const payload=await response.json().catch(()=>({}));
      if(!response.ok){if(payload.session)applyPreviewSessionPayload(payload.session);throw new Error(payload.error||'预览队列更新失败');}
      applyPreviewSessionPayload(payload.session);
    }catch(error){console.warn('Preview operation failed:',error.message);renderPreviewDock();renderDraft();renderLibrary($('#search')?.value||'');}
  });
}
const escapeHtml=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
let qualityReport=null;
const metadataNoise=value=>{const text=String(value||'').replace(/\s+/g,'');return !text||/^\d+$/.test(text)||/^(?:第)?\d+(?:页|页面|slide|page)$/i.test(text)||/^p\d+$/i.test(text);};
const visibleTitle=page=>((metadataNoise(page?.title)||page?.title==='未识别标题')&&page?.titleSource!=='manual')?'待补充标题':String(page?.title||'待补充标题');
const visibleDescription=page=>{const value=String(page?.description||'').trim();return metadataNoise(value)||value===visibleTitle(page)?'':value;};
const isLibraryVisible=page=>page?.libraryStatus!=='excluded'&&!(page?.sourceType==='ai-generated'&&page?.libraryStatus==='draft');
const libraryPages=()=>pages.filter(isLibraryVisible);
function autosizeDescription(){
  const textarea=$('#label-description');
  if(!textarea)return;
  textarea.style.height='auto';
  textarea.style.height=`${Math.max(textarea.scrollHeight,52)}px`;
}
const annotationState=page=>{
  const aiStatus=String(page?.aiLabeling?.status||'').toLowerCase();
  if(page?.reviewStatus==='confirmed')return {key:'confirmed',label:'已确认'};
  if(['succeeded','completed','complete','ready','review'].includes(aiStatus)||String(page?.annotationSource||'').startsWith('deepseek'))return {key:'review',label:'待确认'};
  if(['processing','running','queued'].includes(aiStatus))return {key:'processing',label:'标注中'};
  return {key:'pending',label:'待标注'};
};
const annotationCounts=()=>libraryState.loaded&&Object.keys(libraryState.counts).length?libraryState.counts:libraryPages().reduce((counts,page)=>{counts[annotationState(page).key]=(counts[annotationState(page).key]||0)+1;return counts;},{});
function renderAnnotationSummary(){
  const summary=$('#ai-annotation-summary');const button=$('#ai-batch-annotate');if(!summary)return;
  const counts=annotationCounts();const pending=(counts.pending||0)+(counts.processing||0);
  summary.textContent=`待标注 ${counts.pending||0} · 待确认 ${counts.review||0} · 已确认 ${counts.confirmed||0}`;
  if(button){button.disabled=Boolean(window.aiAnnotationBusy)||pending===0;button.textContent=window.aiAnnotationBusy?'正在标注…':pending?'AI 批量预标注':'已完成预标注';}
}
function renderQualityList(tab='duplicates'){
  const list=$('#quality-list');if(!list||!qualityReport)return;
  if(tab==='issues'){
    list.innerHTML=qualityReport.qualityIssues.length?qualityReport.qualityIssues.map(item=>`<button class="quality-row" type="button" data-quality-page-id="${escapeHtml(item.page.id)}"><span class="quality-previews"><img src="${item.page.preview||''}" alt="" loading="lazy"></span><span class="quality-row-main"><b>${escapeHtml(item.page.title)}</b><small>${escapeHtml(item.reasons.join('、'))}</small></span><span class="quality-row-action">查看详情</span></button>`).join(''):'<div class="quality-empty">未发现明显质量问题。</div>';
  }else{
    list.innerHTML=qualityReport.duplicateCandidates.length?qualityReport.duplicateCandidates.map(item=>`<div class="quality-row"><span class="quality-previews">${item.pages.map(page=>`<img src="${page.preview||''}" alt="" loading="lazy">`).join('')}</span><span class="quality-row-main"><b>${escapeHtml(item.reason)} · ${Math.round(item.score*100)}%</b><small>${item.pages.map(page=>escapeHtml(`${page.title}（${page.id}）`)).join(' / ')}</small></span><button class="quality-row-action" type="button" data-quality-page-id="${escapeHtml(item.pages[0].id)}">查看详情</button></div>`).join(''):'<div class="quality-empty">未发现重复候选。</div>';
  }
  list.querySelectorAll('[data-quality-page-id]').forEach(button=>button.addEventListener('click',()=>{ $('#quality-dialog').close();openLabel(button.dataset.qualityPageId); }));
}
async function openQualityDialog(){
  const dialog=$('#quality-dialog');
  if(!qualityReport){
    try{const response=await fetch('/api/quality/report');if(!response.ok)throw new Error('报告不可用');qualityReport=await response.json();}
    catch(error){window.alert(`质量报告加载失败：${error.message}`);return;}
  }
  $('#quality-total').textContent=qualityReport.totalPages;
  $('#quality-duplicates').textContent=qualityReport.duplicateCandidateCount;
  $('#quality-issues').textContent=qualityReport.qualityIssueCount;
  document.querySelectorAll('.quality-tab').forEach(tab=>tab.classList.toggle('active',tab.dataset.qualityTab==='duplicates'));
  renderQualityList('duplicates');dialog.showModal();
}
const saveAi=()=>{localStorage.setItem(AI_SESSION_STORAGE,JSON.stringify(aiSessions));localStorage.setItem('ppt-ai-active-session',activeAiSessionId);};
function newAiSession(){
  const now=Date.now();
  const session={id:`ai-${now}`,title:'新对话',createdAt:now,updatedAt:now,status:'idle',draftIds:[...draft],referencePageId:null,pendingReferencePageId:null,messages:[{role:'system',text:'对话已创建。可以描述要制作或调整的 PPT。'}]};
  aiSessions.unshift(session);activeAiSessionId=session.id;previewSessionReady=false;previewSessionId='';saveAi();renderAiPanel();bootstrapPreviewSession();
}
function activeAiSession(){return aiSessions.find(session=>session.id===activeAiSessionId)||aiSessions[0];}
function activeReferencePage(){const session=activeAiSession();const id=session?.pendingReferencePageId ?? session?.referencePageId;return pages.find(page=>page.id===id)||null;}
function setAiReferencePage(pageId){const session=activeAiSession();if(!session)return;session.pendingReferencePageId=pageId||null;session.referencePageId=null;session.updatedAt=Date.now();saveAi();renderAiPanel();$('#ai-input')?.focus();}
let aiChatBusy=false;
let aiAttachedSourceFile=null;
function extractChatTargetCustomer(text){
  const match=String(text||'').match(/(?:改成|改为|面向|替换为|换成)\s*([^，。！？；;]+)/u);
  return match?match[1].trim().replace(/^(?:面向|给|为)\s*/u,'').replace(/(?:改写|方案|版本)$/u,'').replace(/[的地]$/u,'').trim().slice(0,80):'';
}
function renderAiAttachment(){
  const button=$('#ai-attach');if(!button)return;
  button.classList.toggle('has-file',Boolean(aiAttachedSourceFile));
  button.textContent=aiAttachedSourceFile?'●':'＋';
  button.title=aiAttachedSourceFile?`已附加 ${aiAttachedSourceFile.name}，点击更换`:'附加源 PPT';
}
function renderAiMessage(message){
  if(message.kind!=='agent'){
    const reference=message.referencePageId?pages.find(page=>page.id===message.referencePageId):null;
    const referenceHtml=reference?`<div class="ai-message-reference"><img src="${reference.preview||''}" alt=""><span>引用：${escapeHtml(visibleTitle(reference))}</span></div>`:'';
    return `<div class="ai-message ${message.role==='user'?'user':'system'}">${referenceHtml}${escapeHtml(message.text||'')}</div>`;
  }
  const workflow=message.mode==='workflow';
  const steps=Array.isArray(message.steps)?message.steps:[];
  const visible=message.progressExpanded?steps:steps.slice(-3);
  const plan=['single_page','multi_page'].includes(message.plan?.kind)&&Array.isArray(message.plan.pages)?`<div class="ai-plan-summary"><div class="ai-plan-head"><b>页面提纲与处理决策</b><small>${message.plan.pageCount} 页</small></div><div class="ai-plan-list">${message.plan.pages.map(item=>`<div class="ai-plan-row"><span class="ai-plan-index">${item.index}</span><span class="ai-plan-copy"><b>${escapeHtml(item.title||item.topic||'未命名页面')}</b><small>${escapeHtml(item.purpose||'')}</small></span><span class="ai-plan-decision ${escapeHtml(item.decision||'new')}">${item.decision==='direct_reuse'?'直接复用':item.decision==='adapt'?'调整生成':'新建'}</span>${item.matchedPage?`<em>${escapeHtml(item.matchedPage.id)}</em>`:''}</div>`).join('')}</div></div>`:'';
  const progress=workflow&&steps.length?`<div class="ai-workflow-progress ${message.progressCollapsed?'collapsed':''}"><button class="ai-progress-toggle" type="button" data-progress-message="${escapeHtml(message.createdAt)}" aria-expanded="${!message.progressCollapsed}"><span>执行进度</span><small>${message.progressCollapsed?'已完成':`${steps.filter(step=>step.status==='completed'||step.status==='skipped').length}/${steps.length}`}</small><b>${message.progressCollapsed?'⌄':'⌃'}</b></button>${message.progressCollapsed?'':`<div class="ai-progress-list">${visible.map(step=>`<div class="ai-progress-step ${escapeHtml(step.status||'running')}"><i>${step.status==='completed'?'✓':step.status==='failed'?'!':step.status==='skipped'?'–':'·'}</i><span>${escapeHtml(step.label||'执行步骤')}${step.detail?`<small>${escapeHtml(step.detail)}</small>`:''}</span></div>`).join('')}${steps.length>3?`<button class="ai-progress-more" type="button" data-progress-expand="${escapeHtml(message.createdAt)}">${message.progressExpanded?'收起步骤':`查看全部 ${steps.length} 步`}</button>`:''}</div>`}</div>`:'';
  return `<div class="ai-message assistant ai-agent-message">${progress}${plan}<div class="ai-agent-text">${escapeHtml(message.text||'')}${message.streaming?'<span class="ai-stream-caret" aria-hidden="true"></span>':''}</div>${message.error?`<div class="ai-agent-error">${escapeHtml(message.error)}</div>`:''}</div>`;
}
function updateAiTaskContext(){
  const context=$('#ai-task-context');if(!context)return;
  const session=activeAiSession();context.textContent=draft.length?`${draft.length} 页预览 · ${session?.title||'当前任务'}`:'未添加页面 · 可开始描述目标';
}
function renderAiPanel(){
  if(!aiSessions.length){newAiSession();return;}
  const session=activeAiSession();if(!session)return;
  if(!('referencePageId' in session))session.referencePageId=null;
  if(!('pendingReferencePageId' in session))session.pendingReferencePageId=session.referencePageId||null;
  const title=$('#ai-task-title');if(title)title.textContent=session.title;
  const list=$('#ai-task-menu-list');
  if(list)list.innerHTML=aiSessions.map(item=>`<button class="ai-session ${item.id===session.id?'active':''}" type="button" data-ai-session-id="${escapeHtml(item.id)}"><b>${escapeHtml(item.title)}</b><small>${new Date(item.updatedAt).toLocaleDateString('zh-CN')} · ${item.messages.filter(message=>message.role==='user').length} 条消息</small></button>`).join('');
  const referencePanel=$('#ai-reference-panel');
  const reference=activeReferencePage();
  if(session.pendingReferencePageId&&!reference){
    fetchPageRecords([session.pendingReferencePageId]).then(()=>renderAiPanel()).catch(error=>console.warn(`引用页面加载失败：${error.message}`));
  }
  if(referencePanel){
    referencePanel.hidden=!reference;
    referencePanel.innerHTML=reference?`<div class="ai-reference-card"><button class="ai-reference-thumb" type="button" data-reference-open="${escapeHtml(reference.id)}" aria-label="查看引用页面"><img src="${reference.preview||''}" alt="${escapeHtml(visibleTitle(reference))}"></button><div class="ai-reference-copy"><small>引用页面</small><b>${escapeHtml(visibleTitle(reference))}</b><span>${escapeHtml(reference.id)}</span></div><button class="ai-reference-remove" type="button" data-reference-remove aria-label="移除引用" title="移除引用">×</button></div>`:'';
    referencePanel.querySelector('[data-reference-remove]')?.addEventListener('click',()=>setAiReferencePage(null));
    referencePanel.querySelector('[data-reference-open]')?.addEventListener('click',()=>openLabel(reference.id));
  }
  const messages=$('#ai-message-list');
  if(messages){messages.innerHTML=session.messages.map(renderAiMessage).join('');messages.scrollTop=messages.scrollHeight;}
  updateAiTaskContext();
  messages?.querySelectorAll('[data-progress-message]').forEach(button=>button.addEventListener('click',()=>{const target=session.messages.find(item=>item.kind==='agent'&&String(item.createdAt)===button.dataset.progressMessage);if(target){target.progressCollapsed=!target.progressCollapsed;saveAi();renderAiPanel();}}));
  messages?.querySelectorAll('[data-progress-expand]').forEach(button=>button.addEventListener('click',()=>{const target=session.messages.find(item=>item.kind==='agent'&&String(item.createdAt)===button.dataset.progressExpand);if(target){target.progressExpanded=!target.progressExpanded;saveAi();renderAiPanel();}}));
  list?.querySelectorAll('[data-ai-session-id]').forEach(button=>button.addEventListener('click',()=>{activeAiSessionId=button.dataset.aiSessionId;previewSessionReady=false;previewSessionId='';saveAi();$('#ai-task-menu-toggle').setAttribute('aria-expanded','false');list.classList.remove('open');renderAiPanel();bootstrapPreviewSession();}));
}
function appendAiMessage(role,text,sessionId=activeAiSessionId){
  const session=aiSessions.find(item=>item.id===sessionId);if(!session)return;
  session.messages.push({role,text,createdAt:Date.now()});session.updatedAt=Date.now();
  if(role==='user'&&session.title==='新对话')session.title=text.slice(0,24);
  session.draftIds=[...draft];saveAi();renderAiPanel();
}
function parseAgentSseFrame(frame,handler){
  const lines=frame.split(/\r?\n/);let event='message';let data='';
  lines.forEach(line=>{if(line.startsWith('event:'))event=line.slice(6).trim();else if(line.startsWith('data:'))data+=line.slice(5).trim();});
  if(!data)return;try{handler(event,JSON.parse(data));}catch{}
}
async function runAgentChat(text,sessionId=activeAiSessionId){
  if(aiChatBusy)return;
  const session=aiSessions.find(item=>item.id===sessionId);if(!session)return;
  aiChatBusy=true;const send=$('#ai-compose button');if(send)send.disabled=true;
  const now=Date.now();
  const referencePageId=session.pendingReferencePageId||null;
  session.messages.push({role:'user',text,referencePageId,createdAt:now});
  session.pendingReferencePageId=null;
  session.referencePageId=null;
  if(session.title==='新对话')session.title=text.slice(0,24);
  const agentMessage={role:'assistant',kind:'agent',text:'',steps:[],retries:[],streaming:true,progressCollapsed:false,progressExpanded:false,createdAt:now};
  session.messages.push(agentMessage);session.updatedAt=now;session.draftIds=[...draft];saveAi();renderAiPanel();
  const history=session.messages.filter(item=>item!==agentMessage&&['user','assistant'].includes(item.role)).slice(-8).map(item=>({role:item.role,content:item.text||''}));
  try{
    const attachedSource=aiAttachedSourceFile;
    const attachedTarget=extractChatTargetCustomer(text);
    if(attachedSource&&attachedTarget){
      const form=new FormData();
      form.append('file',attachedSource,attachedSource.name);
      form.append('targetCustomer',attachedTarget);
      const response=await fetch('/api/customer-rewrite',{method:'POST',body:form});
      const payload=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(payload.error||`客户化改写任务创建失败（${response.status}）`);
      const task=payload.task||payload;
      customerRewriteTasks=[task,...customerRewriteTasks.filter(item=>item.id!==task.id)];
      save();
      agentMessage.mode='workflow';
      agentMessage.steps=[{id:'customer-rewrite-upload',label:'接收源 PPT',status:'completed',detail:attachedSource.name},{id:'customer-rewrite-task',label:'创建客户化改写任务',status:'completed',detail:`目标客户：${attachedTarget}`}];
      agentMessage.text=`已创建客户化改写任务：${attachedSource.name} → ${attachedTarget}。任务会先逐页分析保留、改写、待确认和删除，再生成可编辑过程稿。你可以在导入记录中查看进度和变更计划。`;
      agentMessage.streaming=false;
      aiAttachedSourceFile=null;renderAiAttachment();
      session.updatedAt=Date.now();saveAi();renderAiPanel();
      selectView('imports');
      startCustomerRewritePolling();
      return;
    }
    if(attachedSource&&!attachedTarget){
      agentMessage.text='已附加源 PPT。请在消息中说明要改成哪一家客户，例如“改成面向可口可乐”。';
      agentMessage.streaming=false;
      session.updatedAt=Date.now();saveAi();renderAiPanel();
      return;
    }
    const response=await fetch('/api/agent/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId,message:text,draftIds:[...draft],history,referencePageId})});
    if(!response.ok)throw new Error(await response.text()||`请求失败（${response.status}）`);
    if(!response.body)throw new Error('浏览器不支持流式响应');
    const reader=response.body.getReader();const decoder=new TextDecoder();let buffer='';
    const handle=(event,payload)=>{
      if(event==='task')agentMessage.taskId=payload.id;
      else if(event==='mode'){agentMessage.mode=payload.mode;if(payload.mode!=='workflow')agentMessage.steps=[];}
      else if(event==='preview-state'){applyPreviewSessionPayload(payload);renderPreviewDock();renderLibrary($('#search')?.value||'');renderDraft();updateAiTaskContext();}
      else if(event==='plan'){agentMessage.plan=payload;if(['single_page','multi_page'].includes(payload.kind))agentMessage.progressExpanded=true;}
      else if(event==='stage'||event==='step'){const existing=agentMessage.steps.find(step=>step.id===payload.id);if(existing)Object.assign(existing,payload);else agentMessage.steps.push(payload);}
      else if(event==='selection'){
        const ids=Array.isArray(payload.pageIds)?payload.pageIds.filter(id=>pages.some(page=>page.id===id)):[];
        if(Array.isArray(payload.pageIds)&&payload.sessionId){
          applyPreviewSessionPayload(payload);
          renderPreviewDock();renderLibrary($('#search')?.value||'');renderDraft();updateAiTaskContext();
        } else if(ids.length){
          draft=payload.action==='remove'?draft.filter(id=>!ids.includes(id)):payload.action==='append'?[...new Set([...draft,...ids])]:[...new Set(ids)];
          save();renderPreviewDock();renderLibrary($('#search')?.value||'');renderDraft();updateAiTaskContext();
        }
      }
      else if(event==='generated'){
        const page=payload?.page;
        if(page?.id&&!pages.some(item=>item.id===page.id)){pages.push(page);save();}
        session.generatedPageIds=[...(session.generatedPageIds||[]),page?.id].filter(Boolean);
        renderPreviewDock();renderLibrary($('#search')?.value||'');renderDraft();updateAiTaskContext();
      }
      else if(event==='token')agentMessage.text+=String(payload.token||'');
      else if(event==='retry'){agentMessage.retries.push(payload);if(agentMessage.mode==='workflow'){const stage={id:'model-response',label:'生成方案回复',status:'running',detail:`第 ${payload.attempt||2} 次尝试`};const existing=agentMessage.steps.find(step=>step.id===stage.id);if(existing)Object.assign(existing,stage);else agentMessage.steps.push(stage);}}
      else if(event==='error'){agentMessage.error=payload.message||'Agent 请求失败';agentMessage.streaming=false;}
      else if(event==='done'){if(!agentMessage.text.trim())agentMessage.text=agentMessage.mode==='workflow'?'已完成当前页面调整。':'我已收到，请继续描述你的问题。';agentMessage.streaming=false;if(agentMessage.mode==='workflow'){agentMessage.steps.forEach(step=>{if(step.status==='running')step.status='completed';});agentMessage.progressCollapsed=true;}}
      session.updatedAt=Date.now();saveAi();renderAiPanel();
    };
    while(true){const {done,value}=await reader.read();buffer+=decoder.decode(value||new Uint8Array(),{stream:!done});const frames=buffer.split(/\r?\n\r?\n/);buffer=frames.pop()||'';frames.forEach(frame=>parseAgentSseFrame(frame,handle));if(done)break;}
    if(buffer.trim())parseAgentSseFrame(buffer,handle);
  }catch(error){agentMessage.error=error.message||'Agent 请求失败';agentMessage.streaming=false;session.updatedAt=Date.now();saveAi();renderAiPanel();}
  finally{aiChatBusy=false;if(send)send.disabled=false;}
}
const thumb=page=>page?.preview?`<img style="display:block;width:100%;height:100%;object-fit:cover;border-radius:4px;border:1px solid #dce7df" src="${page.preview}" alt="${page.title||'页面预览'}" loading="lazy">`:'<div class="sheet"><div class="line green"></div><div class="line dark"></div><div class="line dark short"></div><div class="line"></div><div class="line short"></div><div class="bars"><i></i><i></i><i></i><i></i><i></i></div></div>';
function renderLibrary(query=''){
  const source=libraryState.loaded?libraryItems:libraryPages();
  const list=source.filter(p=>`${p.title||''}${p.type||''}${(p.tags||[]).join('')} ${(p.sceneTags||[]).join('')} ${p.sourceFile||''}`.toLowerCase().includes(query.toLowerCase())).filter(p=>!activeFilters.structure.size||[...activeFilters.structure].some(tag=>(p.structureTags||[]).includes(tag))).filter(p=>!activeFilters.scene.size||[...activeFilters.scene].some(tag=>(p.sceneTags||p.scenarios||[]).includes(tag))).filter(p=>activeFilters.status==='all'||annotationState(p).key===activeFilters.status);
  $('#library-grid').innerHTML=list.map(p=>{
    const structureTags=[...(p.structureTags||[])];
    if(!structureTags.length&&p.type)structureTags.push(p.type);
    const sceneTags=[...(p.sceneTags||p.scenarios||[])];
    const title=visibleTitle(p);
    const description=visibleDescription(p);
    const showDescription=Boolean(description);
    const inPreview=draft.includes(p.id);
    const review=annotationState(p);
    return `<article class="card" tabindex="0" role="button" aria-label="打开页面标注：${escapeHtml(title)}" data-card-id="${p.id}"><div class="thumb">${thumb(p)}${inPreview?'<span class="preview-status">已添加</span>':''}</div><div class="card-body"><div class="card-top"><h3>${escapeHtml(title)}</h3><span class="ai-review-status ${review.key}">${review.label}</span></div><div class="chips">${structureTags.map(t=>`<span class="chip structure">${escapeHtml(t)}</span>`).join('')}${sceneTags.map(t=>`<span class="chip scene">${escapeHtml(t)}</span>`).join('')}</div>${showDescription?`<p class="card-description">${escapeHtml(description)}</p>`:''}<button class="preview-action ${inPreview?'remove':''}" data-add-id="${p.id}" aria-label="${inPreview?'从预览移除':'添加到预览'}">${inPreview?'从预览移除':'添加到预览'}</button></div></article>`;
  }).join('')||'<div class="empty">没有匹配的页面，换个关键词试试。</div>';
  const resultCount=$('#library-result-count');
  if(resultCount)resultCount.textContent=libraryState.loaded?`${list.length} / ${libraryState.total}`:`${list.length} / ${libraryPages().length}`;
  renderLibraryPagination();
  renderAnnotationSummary();
  document.querySelectorAll('[data-card-id]').forEach(card=>{
    card.addEventListener('click',()=>openLabel(card.dataset.cardId));
    card.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();openLabel(card.dataset.cardId);}});
    card.addEventListener('contextmenu',event=>{event.preventDefault();openCardContextMenu(card.dataset.cardId,event.clientX,event.clientY);});
    card.addEventListener('mouseenter',()=>highlightPreviewCard(card.dataset.cardId,true));
    card.addEventListener('mouseleave',()=>highlightPreviewCard(card.dataset.cardId,false));
  });
  document.querySelectorAll('.preview-action').forEach(b=>b.addEventListener('click',event=>{event.stopPropagation();togglePreviewPage(b.dataset.addId);b.blur();}));
}
function renderLibraryPagination(){
  const container=$('#library-pagination');if(!container)return;
  if(!libraryState.loaded||libraryState.totalPages<=1){container.innerHTML='';return;}
  container.innerHTML=`<button type="button" class="secondary library-page-button" data-library-page="${Math.max(1,libraryState.page-1)}" ${libraryState.page<=1?'disabled':''}>上一页</button><span>第 ${libraryState.page} / ${libraryState.totalPages} 页 · 共 ${libraryState.total} 页</span><button type="button" class="secondary library-page-button" data-library-page="${Math.min(libraryState.totalPages,libraryState.page+1)}" ${libraryState.page>=libraryState.totalPages?'disabled':''}>下一页</button>`;
  container.querySelectorAll('[data-library-page]').forEach(button=>button.addEventListener('click',()=>loadLibraryPage(Number(button.dataset.libraryPage))));
}
function openCardContextMenu(pageId,x,y){
  const menu=$('#card-context-menu');if(!menu)return;
  contextMenuPageId=pageId;
  const page=pages.find(item=>item.id===pageId);const button=$('#card-context-add-chat');
  if(button){button.disabled=activeReferencePage()?.id===pageId;button.textContent=button.disabled?'已添加到对话':'添加到对话';}
  menu.hidden=false;
  const rect=menu.getBoundingClientRect();
  menu.style.left=`${Math.max(8,Math.min(x,window.innerWidth-rect.width-8))}px`;
  menu.style.top=`${Math.max(8,Math.min(y,window.innerHeight-rect.height-8))}px`;
  if(!page)menu.hidden=true;
}
function closeCardContextMenu(){const menu=$('#card-context-menu');if(menu)menu.hidden=true;contextMenuPageId='';}
function highlightPreviewCard(id,active){
  $('#preview-dock')?.querySelectorAll('.preview-card').forEach(card=>{
    card.classList.toggle('library-hover',active&&card.dataset.previewId===id);
  });
}
function highlightLibraryCard(id,active){
  [...document.querySelectorAll('[data-card-id]')].find(card=>card.dataset.cardId===id)?.classList.toggle('preview-target-hover',active);
}
function previewCardMarkup(page,index,total){
  const center=(total-1)/2;
  const angle=Math.max(-7,Math.min(7,(index-center)*1.4));
  const title=visibleTitle(page);
  return `<article class="preview-card" tabindex="0" role="button" draggable="true" data-preview-id="${page.id}" style="--stack-angle:${angle.toFixed(2)}deg;--deal-index:${index};--deal-delay:${Math.min(index,14)*28}ms;z-index:${total-index}" aria-label="打开页面标注：${escapeHtml(title)}"><img src="${page.preview||''}" alt="${escapeHtml(title)}"><span>${index+1}</span><button type="button" class="preview-card-remove" data-remove-preview-id="${page.id}" aria-label="从预览移除">×</button></article>`;
}
function bindPreviewCard(card){
  card.addEventListener('click',event=>{if(event.target.closest('.preview-card-remove'))return;event.stopPropagation();openLabel(card.dataset.previewId);});
  card.addEventListener('keydown',event=>{if((event.key==='Enter'||event.key===' ')&&!event.target.closest('.preview-card-remove')){event.preventDefault();openLabel(card.dataset.previewId);}});
  card.querySelector('.preview-card-remove').addEventListener('click',event=>{event.stopPropagation();togglePreviewPage(card.dataset.previewId);});
  card.addEventListener('mouseenter',()=>highlightLibraryCard(card.dataset.previewId,true));
  card.addEventListener('mouseleave',()=>highlightLibraryCard(card.dataset.previewId,false));
  card.addEventListener('dragstart',event=>{event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',card.dataset.previewId);card.classList.add('dragging');});
  card.addEventListener('dragend',()=>card.classList.remove('dragging'));
  card.addEventListener('dragover',event=>{event.preventDefault();card.classList.add('drag-over');});
  card.addEventListener('dragleave',()=>card.classList.remove('drag-over'));
  card.addEventListener('drop',event=>{event.preventDefault();card.classList.remove('drag-over');moveDraft(event.dataTransfer.getData('text/plain'),card.dataset.previewId);});
}
function refreshPreviewDockMeta(){
  const dock=$('#preview-dock');
  const count=draft.length;
  const small=dock.querySelector('.preview-dock-head small');
  if(small)small.textContent=`${count} 页`;
  dock.querySelectorAll('.preview-card').forEach((card,index)=>{
    const center=(count-1)/2;
    const angle=Math.max(-7,Math.min(7,(index-center)*1.4));
    card.style.setProperty('--stack-angle',`${angle.toFixed(2)}deg`);card.style.zIndex=String(count-index);card.querySelector('span').textContent=index+1;
  });
}
function updateLibraryCard(id){
  const card=[...document.querySelectorAll('[data-card-id]')].find(item=>item.dataset.cardId===id);
  if(!card)return;
  const added=draft.includes(id);const thumbEl=card.querySelector('.thumb');let status=thumbEl.querySelector('.preview-status');
  if(added&&!status){status=document.createElement('span');status.className='preview-status';status.textContent='已添加';thumbEl.insertBefore(status,thumbEl.querySelector('.page-no'));}
  if(!added&&status)status.remove();
  const action=card.querySelector('.preview-action');if(action){action.classList.toggle('remove',added);action.textContent=added?'从预览移除':'添加到预览';action.setAttribute('aria-label',action.textContent);}
}
function togglePreviewPage(id){
  const page=pages.find(item=>item.id===id);if(!page)return;
  if(draft.includes(id)){
    const index=draft.indexOf(id);draft=draft.filter(item=>item!==id);save();persistPreviewOperation({type:'remove_at',index,expectedPageId:id});updateLibraryCard(id);
    const card=[...$('#preview-dock').querySelectorAll('.preview-card')].find(item=>item.dataset.previewId===id);
    if(card){const width=card.getBoundingClientRect().width;card.style.width=`${width}px`;card.classList.add('preview-removing');requestAnimationFrame(()=>{card.style.width='0px';card.style.marginLeft='0';card.style.borderWidth='0'});setTimeout(()=>{card.remove();if(!draft.length)renderPreviewDock();else refreshPreviewDockMeta();},340);}else renderPreviewDock();
  }else{
    draft.push(id);save();persistPreviewOperation({type:'append',pageIds:[id]});updateLibraryCard(id);
    const dock=$('#preview-dock');const stack=dock.querySelector('.preview-stack');
    if(!stack){renderPreviewDock();revealAddedPreview(id);}
    else {stack.insertAdjacentHTML('beforeend',previewCardMarkup(page,draft.length-1,draft.length));const card=stack.lastElementChild;bindPreviewCard(card);refreshPreviewDockMeta();card.classList.add('preview-new');revealAddedPreview(id);}
  }
}
function revealAddedPreview(id){
  const dock=$('#preview-dock');
  const stack=dock?.querySelector('.preview-stack');
  const card=[...(stack?.querySelectorAll('.preview-card')||[])].find(item=>item.dataset.previewId===id);
  if(!stack||!card)return;
  stack.scrollTo({top:stack.scrollHeight,behavior:'smooth'});
  card.classList.remove('preview-added-highlight');
  requestAnimationFrame(()=>card.classList.add('preview-added-highlight'));
  window.setTimeout(()=>card.classList.remove('preview-added-highlight'),1700);
}
function clearPreviewQueue(){
  if(!draft.length)return;
  if(!window.confirm('确认清空右侧预览吗？'))return;
  draft=[];previewIndex=0;save();persistPreviewOperation({type:'replace_all',pageIds:[]});renderPreviewDock();renderLibrary($('#search')?.value||'');updateAiTaskContext();
}
function renderPreviewDock(){
  const selected=draft.map(id=>pages.find(p=>p.id===id)).filter(Boolean);
  const dock=$('#preview-dock');
  if(!selected.length){dock.className=`preview-dock empty${previewDockExpanded?' expanded':''}`;dock.innerHTML=`<div class="preview-dock-head"><div><b>预览</b><small>尚未添加页面</small></div><button type="button" class="preview-dock-toggle" aria-label="${previewDockExpanded?'收起预览':'展开预览'}">${previewDockExpanded?'⌃':'›'}</button></div><div class="preview-empty-state"><b>预览队列为空</b><small>在资源库卡片上点击“添加到预览”，页面会出现在这里。</small></div>`;dock.querySelector('.preview-dock-toggle').addEventListener('click',()=>{previewDockExpanded=!previewDockExpanded;renderPreviewDock();});updateAiTaskContext();return;}
  dock.className=`preview-dock has-pages${previewDockExpanded?' expanded':''}`;
  const cards=selected.map((p,i)=>previewCardMarkup(p,i,selected.length)).join('');
  dock.innerHTML=`<div class="preview-dock-head"><div><b>预览</b><small>${selected.length} 页</small></div><div class="preview-dock-actions">${!previewDockExpanded?'<button type="button" class="preview-dock-action preview-dock-clear">清空</button>':''}${previewDockExpanded?'<button type="button" class="preview-dock-action preview-dock-preview">在线预览</button><button type="button" class="preview-dock-action preview-dock-export">导出 PPT</button>':''}<button type="button" class="preview-dock-toggle" aria-label="${previewDockExpanded?'收起预览':'展开预览'}" title="${previewDockExpanded?'收起':'展开'}">${previewDockExpanded?'⌃':'›'}</button></div></div><div class="preview-stack">${cards}</div>`;
  dock.querySelector('.preview-dock-toggle').addEventListener('click',event=>{event.stopPropagation();previewDockExpanded=!previewDockExpanded;renderPreviewDock();});
  dock.querySelector('.preview-dock-clear')?.addEventListener('click',event=>{event.stopPropagation();clearPreviewQueue();});
  dock.querySelector('.preview-dock-preview')?.addEventListener('click',event=>{event.stopPropagation();openPreviewLink(draft);});
  dock.querySelector('.preview-dock-export')?.addEventListener('click',event=>{event.stopPropagation();openExportDialog(draft,`PPT-Master-${draft.length}页`);});
  dock.querySelectorAll('.preview-card').forEach(bindPreviewCard);
  updateAiTaskContext();
}
function animatePreviewReorder(fromId,toId){
  const stack=$('#preview-dock .preview-stack');
  if(!stack)return false;
  const cards=[...stack.querySelectorAll('.preview-card')];
  const moved=cards.find(card=>card.dataset.previewId===fromId);const target=cards.find(card=>card.dataset.previewId===toId);
  if(!moved||!target)return false;
  const before=new Map(cards.map(card=>[card.dataset.previewId,card.getBoundingClientRect()]));
  const fromIndex=cards.indexOf(moved);const toIndex=cards.indexOf(target);
  if(fromIndex<toIndex)stack.insertBefore(moved,target.nextSibling);else stack.insertBefore(moved,target);
  refreshPreviewDockMeta();
  const after=[...stack.querySelectorAll('.preview-card')];
  after.forEach(card=>{const old=before.get(card.dataset.previewId);const next=card.getBoundingClientRect();const dx=old.left-next.left;const dy=old.top-next.top;if(!dx&&!dy)return;card.style.transition='none';card.style.transform=`translate(${dx}px,${dy}px)`;requestAnimationFrame(()=>{card.style.transition='transform .34s cubic-bezier(.2,.75,.25,1)';card.style.transform='translate(0,0)';setTimeout(()=>{card.style.transition='';card.style.transform='';},360);});});
  return true;
}
function moveDraft(fromId,toId){
  const from=draft.indexOf(fromId),to=draft.indexOf(toId);
  if(from<0||to<0||from===to)return;
  const currentId=draft[previewIndex];const [moved]=draft.splice(from,1);draft.splice(to,0,moved);previewIndex=Math.max(0,draft.indexOf(currentId));save();persistPreviewOperation({type:'reorder',fromIndex:from,toIndex:to,expectedPageId:fromId});
  const animated=animatePreviewReorder(fromId,toId);
  if(!animated)renderPreviewDock();
}
function renderFilterPanel(){
  const query=$('#search')?.value||'';
  const group=(title,key,items)=>`<div class="filter-group"><b>${title}</b>${items.map(item=>`<label><input type="checkbox" data-filter-key="${key}" value="${item}" ${activeFilters[key].has(item)?'checked':''}>${item}</label>`).join('')}</div>`;
  const counts=libraryState.loaded&&Object.keys(libraryState.counts).length?libraryState.counts:annotationCounts();
  const statusGroup=`<div class="filter-group status-filter"><b>状态</b>${ANNOTATION_STATUS_ENUM.map(([key,label])=>`<label><input type="radio" name="annotation-status" data-filter-status="${key}" ${activeFilters.status===key?'checked':''}>${label}<small>${key==='all'?(libraryState.loaded?(libraryState.counts.all||0):libraryPages().length):(counts[key]||0)}</small></label>`).join('')}</div>`;
  $('#tag-filters').innerHTML=statusGroup+group('结构', 'structure', STRUCTURE_ENUM)+group('场景', 'scene', SCENE_ENUM)+`<label class="filter-search">⌕<span>关键词</span><input id="search" placeholder="搜索页面、关键词、文件"></label>`;
  $('#search').value=query;
  $('#tag-filters').querySelectorAll('input[data-filter-key]').forEach(input=>input.addEventListener('change',()=>{activeFilters[input.dataset.filterKey][input.checked?'add':'delete'](input.value);loadLibraryPage(1);}));
  $('#tag-filters').querySelectorAll('input[data-filter-status]').forEach(input=>input.addEventListener('change',()=>{activeFilters.status=input.dataset.filterStatus;loadLibraryPage(1);}));
  $('#search').addEventListener('input',event=>{clearTimeout(librarySearchTimer);librarySearchTimer=setTimeout(()=>loadLibraryPage(1),220);});
}
function renderSceneTags(selected=[]){
  $('#dialog-scene-tags').innerHTML=SCENE_ENUM.map(tag=>`<label><input type="checkbox" value="${tag}" ${selected.includes(tag)?'checked':''}>${tag}</label>`).join('');
}
function renderQueue(){
  $('#queue-count').textContent=imports.length;
  $('#queue-list').innerHTML=imports.length?imports.map(i=>`<div class="queue-item"><div class="file-icon">PPT</div><div class="queue-info"><b>${escapeHtml(i.name||'未命名 PPT')}</b><small>${i.totalPages?`${i.totalPages} 页 · `:''}${escapeHtml(importStageLabel(i))} · ${escapeHtml(i.time||'刚刚')}</small></div><div class="progress"><i style="width:${i.status==='completed'||i.status==='done'?100:(i.progress||5)}%"></i></div><span class="queue-status ${i.status==='completed'||i.status==='done'?'done':i.status==='failed'?'failed':''}">${i.status==='completed'||i.status==='done'?'已完成':i.status==='failed'?'失败':`处理中 ${i.progress||5}%`}</span></div>`).join(''):'<div class="empty">还没有导入文件。选择一份销售最常用的 PPT 开始拆页。</div>';
}
function mergeImportTasks(items){
  const byId=new Map(items.map(item=>[item.id,item]));
  imports=[...imports.map(item=>byId.get(item.id)||item),...items.filter(item=>!imports.some(existing=>existing.id===item.id))];
  imports.sort((a,b)=>String(b.createdAt||b.time||'').localeCompare(String(a.createdAt||a.time||'')));
  save();renderQueue();renderImportHistory();
}
async function refreshImportTasks(){
  try{const response=await fetch('/api/imports?limit=200');if(!response.ok)return;const payload=await response.json();const previous=new Map(imports.map(item=>[item.id,item.status]));imports=payload.items||[];save();renderQueue();renderImportHistory();if(imports.some(item=>item.status==='completed'&&previous.get(item.id)!=='completed'&&item.deckId)){window.setTimeout(()=>window.location.reload(),350);}}
  catch{}
}
function startImportPolling(){
  if(importPollTimer)return;
  importPollTimer=window.setInterval(async()=>{await refreshImportTasks();if(!imports.some(item=>['queued','uploaded','running'].includes(item.status))) {window.clearInterval(importPollTimer);importPollTimer=null;}},5000);
}
function importStageLabel(item){
  if(item.status==='done'||item.status==='completed')return '已完成';
  if(item.status==='failed')return '失败';
  const stages={queued:'排队中',uploaded:'已上传',splitting:'拆分页面',extracting:'提取元数据',labeling:'AI 标注',matching:'重复匹配',completed:'已完成',failed:'失败'};
  if(stages[item.stage])return stages[item.stage];
  if((item.progress||0)<35)return '拆分页面';
  if((item.progress||0)<70)return '提取元数据';
  return 'AI 标注与匹配';
}
function renderImportHistory(){
  const list=$('#import-history-list');if(!list)return;
  if(!imports.length){list.innerHTML='<div class="import-history-empty">还没有导入记录。点击右上角“导入 PPT”开始。</div>';return;}
  list.innerHTML=imports.map(item=>{
    const total=Number(item.totalPages||item.pageCount||0);const extracted=Number(item.extractedPages||item.pagesExtracted||(item.status==='done'||item.status==='completed'?total:0));const ai=Number(item.aiPages||item.pagesAnnotated||(item.status==='done'||item.status==='completed'?total:0));const duplicates=Number(item.duplicateCount||item.duplicatePages||0);const progress=item.status==='done'||item.status==='completed'?100:Number(item.progress||8);
    const resultText=item.status==='completed'?`识别 ${total} 页 · 新增 ${Number(item.newPages||0)} · 重复 ${duplicates}`:item.error||'处理中，完成后显示识别结果';
    return `<div class="import-history-row"><span class="import-history-file"><b>${escapeHtml(item.name||'未命名 PPT')}</b><small>${escapeHtml(resultText)}</small><small>${escapeHtml(item.batchId||item.id||'')}</small><span class="import-history-progress"><i style="width:${progress}%"></i></span></span><span class="import-history-stage">${escapeHtml(item.time||item.createdAt||'刚刚')}</span><span>${escapeHtml(importStageLabel(item))}</span><span class="import-history-metric"><b>${total||'—'}</b><small>总页数</small></span><span class="import-history-metric"><b>${extracted||'—'}</b><small>已提取</small></span><span class="import-history-metric metric-ai"><b>${ai||'—'}</b><small>AI 完成</small></span><span class="import-history-metric"><b>${duplicates}</b><small>重复候选</small></span><span class="import-history-status ${item.status==='done'||item.status==='completed'?'done':item.status==='failed'?'failed':'processing'}">${item.status==='done'||item.status==='completed'?'已完成':item.status==='failed'?'失败':`处理中 ${progress}%`}</span></div>`;
  }).join('');
}
function rewriteStatusLabel(task){
  if(task.status==='failed')return '失败';
  if(task.status==='processing'||task.status==='queued')return '处理中';
  if(task.deliveryStatus==='deliverable')return '可交付';
  if(task.deliveryStatus==='process')return '待确认';
  return '过程稿';
}
function renderCustomerRewriteTasks(){
  const list=$('#customer-rewrite-list');const count=$('#rewrite-task-count');if(!list)return;
  if(count)count.textContent=`${customerRewriteTasks.length} 个任务`;
  if(!customerRewriteTasks.length){list.innerHTML='<div class="customer-rewrite-empty">还没有客户化改写任务。</div>';return;}
  list.innerHTML=customerRewriteTasks.map(task=>{
    const status=rewriteStatusLabel(task);const metrics=task.metrics||{};
    const gate=task.qualityGate||{};
    const processNote=task.deliveryStatus==='process'?'待确认':task.deliveryStatus==='draft'?'过程稿':'';
    const statusClass=task.status==='review'?'review':task.status==='failed'?'failed':task.status==='processing'||task.status==='queued'?'processing':task.deliveryStatus==='deliverable'?'completed':'pending';
    const materialNote=Array.isArray(task.materials)&&task.materials.length?` · 已绑定 ${task.materials.length} 份资料`:'';
    return `<article class="customer-rewrite-task"><div class="customer-rewrite-task-main"><b>${escapeHtml(task.name||'未命名 PPT')}</b><small>${escapeHtml(task.sourceCustomer||'原客户待识别')} → ${escapeHtml(task.targetCustomer||'目标客户未填写')}${processNote?` · ${processNote}`:''}${materialNote}</small><small>${escapeHtml(task.message||'等待客户化改写处理')}</small>${task.status==='review'||task.deliveryStatus==='process'?`<small>门禁：${gate.pendingPages||metrics.pendingPages||0} 页待确认${gate.brandAssetStatus==='missing-target-logo'?` · 缺少目标客户 Logo`:gate.sourceBrandImageCount?` · 已替换 ${gate.replacedBrandImageCount||0}/${gate.sourceBrandImageCount} 个品牌图片`:''}${gate.sourceTextResiduals?` · ${gate.sourceTextResiduals} 处文字残留`:''}${gate.placeholderPageCount?` · ${gate.placeholderPageCount} 页为空或页码占位`:''}${gate.editablePptx===false?' · 文件不可编辑':''}${gate.zipIntegrity===false?' · 文件不完整':''}</small>`:''}</div><div class="customer-rewrite-metrics"><span><b>${metrics.processedPages??'—'}</b><small>处理页数</small></span><span><b>${metrics.replacedPages??'—'}</b><small>替换页数</small></span><span><b>${metrics.pendingPages??'—'}</b><small>待确认页数</small></span></div><span class="customer-rewrite-status ${statusClass}">${status}${task.status==='processing'||task.status==='queued'?` ${Math.round(task.progress||0)}%`:''}</span>${task.id?`<button class="customer-rewrite-link" type="button" data-rewrite-plan-id="${escapeHtml(task.id)}">变更计划</button>`:''}${task.previewUrl?`<a class="customer-rewrite-link" href="${escapeHtml(task.previewUrl)}" target="_blank" rel="noreferrer">预览</a>`:''}${task.exportUrl?`<a class="customer-rewrite-link" href="${escapeHtml(task.exportUrl)}" download>${task.deliveryStatus==='process'?'下载过程稿':'下载 PPTX'}</a>`:''}</article>`;
  }).join('');
  list.querySelectorAll('[data-rewrite-plan-id]').forEach(button=>button.addEventListener('click',()=>openCustomerRewritePlan(button.dataset.rewritePlanId)));
}
function rewritePlanAction(action){return action==='retain'?'保留':action==='rewrite'?'改写':action==='remove'?'删除':'待确认';}
function rewriteGateIssueLabel(issue){
  const labels={
    'unsupported-customer-rewrite':'源客户长段事实未绑定逐页证据',
    'source-customer-residual':'仍有源客户文字残留',
    'source-text-residual':'仍有待清理的源文案',
    'target-logo-required':'需要目标客户 Logo',
    'placeholder-title':'存在空标题或页码占位',
    'missing-toc':'缺少目录页',
    'invalid-role-order':'封面、目录、尾页顺序需要调整',
    'plan-output-count-mismatch':'计划页数与输出页数不一致',
    'not-editable':'输出文件没有可编辑文本对象',
    'invalid-zip':'输出 PPTX 文件不完整',
  };
  return labels[issue?.code]||String(issue?.message||'质量门禁需要处理');
}
function rewritePreviewMarkup(task,item){
  const preview=(Array.isArray(task.pagePreviews)?task.pagePreviews:[]).find(candidate=>Number(candidate.page)===Number(item.page));
  const button=(url,label,kind)=>url?`<button class="rewrite-preview-thumb ${kind}" type="button" data-rewrite-preview-id="${escapeHtml(task.id)}" data-rewrite-preview-page="${Number(item.page)}" aria-label="查看第 ${Number(item.page)} 页${label}"><img src="${escapeHtml(url)}" alt="第 ${Number(item.page)} 页${label}" loading="lazy"><span>${label}</span></button>`:`<span class="rewrite-preview-placeholder ${kind}">${item.action==='remove'?'此页将删除':'等待生成'}</span>`;
  return `<div class="rewrite-page-comparison">${button(preview?.sourceUrl,'改写前','before')}<span class="rewrite-preview-arrow" aria-hidden="true">→</span>${button(preview?.outputUrl,'改写后','after')}</div>`;
}
function openCustomerRewritePlan(id){
  const task=customerRewriteTasks.find(item=>item.id===id);if(!task)return;
  const dialog=$('#customer-rewrite-plan-dialog');if(!dialog)return;
  dialog.dataset.taskId=id;
  const plan=Array.isArray(task.changePlan)?task.changePlan:[];const metrics=task.metrics||{};
  $('#rewrite-plan-subtitle').textContent=`${task.sourceCustomer||'原客户待识别'} → ${task.targetCustomer||'目标客户'} · ${task.name||'未命名 PPT'}`;
  const processed=metrics.processedPages??(plan.length||'—');const retained=metrics.retainedPages??plan.filter(item=>item.action==='retain').length;const replaced=metrics.replacedPages??plan.filter(item=>item.action==='rewrite').length;const pending=metrics.pendingPages??plan.filter(item=>item.action==='pending').length;
  const gate=task.qualityGate||{};
  const evidence=Array.isArray(task.evidence)?task.evidence:[];
  const evidenceFiles=[...new Set(evidence.map(item=>item.sourceFile).filter(Boolean))];
  const gapPlan=task.gapPagePlan?.gapPagePlan||[];
  const gapSummary=task.gapPagePlan?.summary||{};
  const versions=`计划 v${Number(task.planVersion||0)} · 输出 v${Number(task.outputVersion||0)}`;
  const gateIssues=Array.isArray(gate.fileIssues)?gate.fileIssues:[];
  const gateIssueText=gateIssues.length?`<span class="rewrite-gate-issues">质量门禁：${escapeHtml([...new Set(gateIssues.slice(0,6).map(rewriteGateIssueLabel))].join(' · '))}${gateIssues.length>6?' · …':''}</span>`:'';
  $('#rewrite-plan-summary').innerHTML=`<span><b>${processed}</b> 页已分析</span><span><b>${retained}</b> 页保留</span><span><b>${replaced}</b> 页改写</span><span><b>${pending}</b> 页待确认</span><span>${versions}</span>${evidence.length?`<span><b>${evidence.length}</b> 条资料证据 · ${escapeHtml(evidenceFiles.join('、'))}</span>`:'<span>未提取到客户资料证据</span>'}${gapPlan.length?`<span>缺口页：${gapSummary.create||0} 页新建 · ${gapSummary.rewrite||0} 页改写 · ${gapSummary.pending||0} 页待补</span><span>${gapPlan.map(item=>`${item.title}（${item.action==='create'?'新建':item.action==='rewrite'?'改写':'待补'}）`).join('、')}</span>`:''}${gate.brandImageRiskPages?.length?`<span><b>${gate.brandImageRiskPages.length}</b> 页品牌图片待处理</span>`:''}${(task.missingInputs||[]).length?`<span>待补资料：${escapeHtml(task.missingInputs.join('、'))}</span>`:''}${gateIssueText}`;
  $('#rewrite-plan-list').innerHTML=plan.length?plan.map(item=>`<div class="rewrite-plan-row"><span class="rewrite-plan-index">${item.page}</span>${rewritePreviewMarkup(task,item)}<span class="rewrite-plan-details"><b>${escapeHtml(item.title||`第 ${item.page} 页`)}</b>${item.targetCustomerInputs?.length?`<small>待补：${escapeHtml(item.targetCustomerInputs.join('、'))}</small>`:''}</span><select class="rewrite-plan-action ${escapeHtml(item.action||'pending')}" data-plan-page="${item.page}" aria-label="第 ${item.page} 页处理动作"><option value="retain" ${item.action==='retain'?'selected':''}>保留</option><option value="rewrite" ${item.action==='rewrite'?'selected':''}>改写</option><option value="pending" ${item.action==='pending'?'selected':''}>待确认</option><option value="remove" ${item.action==='remove'?'selected':''}>删除</option></select><small class="rewrite-plan-reason">${escapeHtml(item.reason||'等待分析')}</small></div>`).join(''):'<div class="quality-empty">任务仍在处理，完成后会显示逐页计划。</div>';
  $('#rewrite-plan-list').querySelectorAll('[data-rewrite-preview-id]').forEach(button=>button.addEventListener('click',()=>{
    const current=(Array.isArray(task.pagePreviews)?task.pagePreviews:[]).find(candidate=>Number(candidate.page)===Number(button.dataset.rewritePreviewPage));
    if(current)openCustomerRewritePreview(task,current);
  }));
  $('#save-rewrite-plan').disabled=!plan.length||['queued','processing'].includes(task.status);
  $('#rerun-rewrite-plan').disabled=!plan.length||['queued','processing'].includes(task.status);
  dialog.showModal();
}
function openCustomerRewritePreview(task,item){
  const dialog=$('#customer-rewrite-preview-dialog');if(!dialog)return;
  dialog.querySelector('[data-rewrite-preview-title]').textContent=`第 ${item.page} 页 · ${item.title||'未命名页面'}`;
  const source=dialog.querySelector('[data-rewrite-preview-image="source"]');const output=dialog.querySelector('[data-rewrite-preview-image="output"]');
  source.src=item.sourceUrl||'';source.closest('.rewrite-preview-view').classList.toggle('is-empty',!item.sourceUrl);
  output.src=item.outputUrl||'';output.closest('.rewrite-preview-view').classList.toggle('is-empty',!item.outputUrl);
  dialog.querySelector('[data-rewrite-preview-caption]').textContent=item.action==='remove'?'此页将在输出中删除':item.outputPage?`输出第 ${item.outputPage} 页 · ${rewritePlanAction(item.action)}`:'等待输出渲染';
  dialog.showModal();
}
function rewritePlanUpdates(){return [...document.querySelectorAll('#rewrite-plan-list [data-plan-page]')].map(select=>({page:Number(select.dataset.planPage),action:select.value}));}
async function saveCustomerRewritePlan(rerun=false){
  const dialog=$('#customer-rewrite-plan-dialog');const subtitle=$('#rewrite-plan-subtitle');const id=dialog?.dataset.taskId;
  if(!id)return;
  const updates=rewritePlanUpdates();if(!updates.length)return;
  const saveButton=$('#save-rewrite-plan');const rerunButton=$('#rerun-rewrite-plan');saveButton.disabled=true;rerunButton.disabled=true;subtitle.textContent='正在保存逐页计划…';
  try{
    const response=await fetch(`/api/customer-rewrite/${encodeURIComponent(id)}/plan`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({pages:updates,confirm:true})});
    if(!response.ok)throw new Error((await response.json().catch(()=>null))?.error||`保存失败（${response.status}）`);
    const payload=await response.json();const index=customerRewriteTasks.findIndex(item=>item.id===id);if(index>=0)customerRewriteTasks[index]=payload.task||payload;save();renderCustomerRewriteTasks();
    if(rerun){
      subtitle.textContent='计划已保存，正在重新生成…';
      const rerunResponse=await fetch(`/api/customer-rewrite/${encodeURIComponent(id)}/rerun`,{method:'POST'});
      if(!rerunResponse.ok)throw new Error((await rerunResponse.json().catch(()=>null))?.error||`重新生成失败（${rerunResponse.status}）`);
      const rerunPayload=await rerunResponse.json();const taskIndex=customerRewriteTasks.findIndex(item=>item.id===id);if(taskIndex>=0)customerRewriteTasks[taskIndex]=rerunPayload.task||rerunPayload;save();renderCustomerRewriteTasks();dialog.close();startCustomerRewritePolling();
    }else{subtitle.textContent='逐页计划已保存，点击“保存并重新生成”执行确认动作。';saveButton.disabled=false;rerunButton.disabled=false;}
  }catch(error){subtitle.textContent=`操作失败：${error.message}`;saveButton.disabled=false;rerunButton.disabled=false;}
}
async function refreshCustomerRewriteTasks(){
  try{const response=await fetch('/api/customer-rewrite?limit=200');if(!response.ok)return;const payload=await response.json();customerRewriteTasks=payload.items||[];save();renderCustomerRewriteTasks();}
  catch{}
}
function startCustomerRewritePolling(){
  if(customerRewritePollTimer)return;
  customerRewritePollTimer=window.setInterval(async()=>{await refreshCustomerRewriteTasks();if(!customerRewriteTasks.some(task=>['queued','processing'].includes(task.status))){window.clearInterval(customerRewritePollTimer);customerRewritePollTimer=null;}},3000);
}
function openCustomerRewrite(){
  const dialog=$('#customer-rewrite-dialog');if(!dialog)return;
  $('#customer-rewrite-form').reset();$('#rewrite-file-name').textContent='选择一份源 PPT';$('#rewrite-form-note').textContent='提交后会显示原客户、目标客户、处理页数、替换页数和待确认页数。';dialog.showModal();
}
async function submitCustomerRewrite(event){
  event.preventDefault();
  const file=$('#rewrite-file-input').files[0];const targetCustomer=$('#rewrite-target-customer').value.trim();if(!file||!targetCustomer){$('#rewrite-form-note').textContent='请先选择源 PPT 并填写目标客户。';return;}
  const task={id:`rewrite-${Date.now()}`,name:file.name,sourceCustomer:$('#rewrite-source-customer').value.trim(),targetCustomer,status:'queued',createdAt:Date.now(),message:'正在创建客户化改写任务',metrics:{processedPages:null,replacedPages:null,pendingPages:null}};
  const submit=$('#submit-customer-rewrite');submit.disabled=true;submit.textContent='创建中…';
  try{
    const form=new FormData();form.append('file',file,file.name);form.append('sourceCustomer',task.sourceCustomer);form.append('targetCustomer',task.targetCustomer);const logo=$('#rewrite-logo-input')?.files?.[0];if(logo)form.append('targetLogo',logo,logo.name);[...($('#rewrite-material-input')?.files||[])].forEach(material=>form.append('materials',material,material.name));
    const response=await fetch('/api/customer-rewrite',{method:'POST',body:form});
    if(!response.ok)throw new Error((await response.json().catch(()=>null))?.error||`请求失败（${response.status}）`);
    const payload=await response.json();Object.assign(task,payload.task||payload);task.status=task.status||'processing';task.message=task.message||'任务已提交，等待处理。';
  }catch(error){task.status='failed';task.message=`客户化改写任务创建失败：${error.message}`;}
  customerRewriteTasks=[task,...customerRewriteTasks.filter(item=>item.id!==task.id)];save();renderCustomerRewriteTasks();$('#customer-rewrite-dialog').close();selectView('imports');if(['queued','processing'].includes(task.status))startCustomerRewritePolling();submit.disabled=false;submit.textContent='创建任务';
}
function renderDraft(){
  if(!$('#draft-view'))return;
  const selected=draft.map(id=>pages.find(p=>p.id===id)).filter(Boolean);$('#draft-count').textContent=`${selected.length} 页`;
  if(previewIndex>=selected.length)previewIndex=Math.max(0,selected.length-1);
  const current=selected[previewIndex];
  $('#draft-selection-list').innerHTML=selected.length?selected.map((page,index)=>`<button class="selected-page ${index===previewIndex?'active':''}" draggable="true" data-selected-id="${page.id}" aria-current="${index===previewIndex?'page':'false'}"><img src="${page.preview||''}" alt=""><span class="selected-page-meta"><b>${index+1}. ${page.title}</b><small>第 ${String(page.sourcePage||page.page||index+1).padStart(2,'0')} 页</small></span><span class="selected-page-remove" data-remove-selected="${page.id}" role="button" aria-label="移除第 ${index+1} 页">×</span></button>`).join(''):'<div class="empty">还没有加入页面</div>';
  $('#draft-selection-list').querySelectorAll('[data-selected-id]').forEach(button=>button.addEventListener('click',event=>{if(event.target.closest('[data-remove-selected]'))return;previewIndex=Math.max(0,draft.indexOf(button.dataset.selectedId));renderDraft();}));
  $('#draft-selection-list').querySelectorAll('[data-selected-id]').forEach(button=>{button.addEventListener('dragstart',event=>{event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',button.dataset.selectedId);button.classList.add('dragging');});button.addEventListener('dragend',()=>button.classList.remove('dragging'));button.addEventListener('dragover',event=>{event.preventDefault();button.classList.add('drag-over');});button.addEventListener('dragleave',()=>button.classList.remove('drag-over'));button.addEventListener('drop',event=>{event.preventDefault();button.classList.remove('drag-over');moveDraft(event.dataTransfer.getData('text/plain'),button.dataset.selectedId);});});
  $('#draft-selection-list').querySelectorAll('[data-remove-selected]').forEach(button=>button.addEventListener('click',event=>{event.stopPropagation();const id=button.dataset.removeSelected;const index=draft.indexOf(id);if(index<0)return;draft.splice(index,1);save();persistPreviewOperation({type:'remove_at',index,expectedPageId:id});renderPreviewDock();renderDraft();renderLibrary($('#search').value);}));
  $('#draft-count').textContent=selected.length?`${previewIndex+1} / ${selected.length}`:'0 / 0';
  $('#preview-prev').disabled=!selected.length||previewIndex===0;$('#preview-next').disabled=!selected.length||previewIndex===selected.length-1;
  $('#open-preview').disabled=!selected.length;$('#export-draft-ppt').disabled=!selected.length;
  $('#draft-pages').innerHTML=current?`<figure class="online-slide"><img src="${current.preview}" alt="${current.title}"><figcaption><span>${current.title}</span><button class="remove-draft" data-remove-id="${current.id}">移除本页</button></figcaption></figure>`:'<div class="empty">还没有选中的页面。回到页面库，点击“加入预览”。</div>';
  const remove=$('.remove-draft');if(remove)remove.addEventListener('click',()=>{const id=remove.dataset.removeId;const index=draft.indexOf(id);if(index<0)return;draft.splice(index,1);save();persistPreviewOperation({type:'remove_at',index,expectedPageId:id});renderPreviewDock();renderDraft();renderLibrary($('#search').value);});
}
function openLabel(id){
  active=pages.find(p=>p.id===id)||null;
  if(!active){fetchPageRecords([id]).then(()=>openLabel(id)).catch(error=>window.alert(error.message));return;}
  const titleEditor=$('#dialog-title');titleEditor.value=visibleTitle(active);titleEditor.readOnly=true;titleEditor.setAttribute('aria-readonly','true');$('#dialog-page-id').textContent=active.id;$('#dialog-preview').innerHTML=`<div class="thumb">${thumb(active)}</div>`;$('#label-keywords').value=(active.tags||[]).join('、');$('#label-description').value=visibleDescription(active);autosizeDescription();
  $('#dialog-structure-tags').innerHTML=STRUCTURE_ENUM.map(tag=>`<label><input type="checkbox" value="${tag}" ${((active.structureTags||[]).includes(tag))?'checked':''}>${tag}</label>`).join('');
  renderSceneTags(active.sceneTags||active.scenarios||[]);
  const publish=$('#add-generated-page');
  if(publish){const isDraft=active.sourceType==='ai-generated'&&active.libraryStatus==='draft';publish.hidden=!isDraft;publish.textContent=isDraft?'加入资源库':'已在资源库';publish.disabled=!isDraft;}
  document.body.classList.add('modal-open');
  const dialog=$('#label-dialog');
  dialog.setAttribute('tabindex','-1');
  dialog.showModal();
  // Keep the title in its display state on open; editing is an explicit click.
  requestAnimationFrame(()=>{dialog.focus({preventScroll:true});autosizeDescription();});
}
function selectView(view){document.querySelectorAll('.view').forEach(v=>v.classList.add('hidden'));$(`#${view}-view`).classList.remove('hidden');document.querySelectorAll('.nav-item[data-view]').forEach(n=>n.classList.toggle('active',n.dataset.view===view));const title=$('#view-title');if(title)title.textContent=view==='library'?'资源库':'导入记录';if(view==='imports'){renderImportHistory();refreshCustomerRewriteTasks().then(()=>{if(customerRewriteTasks.some(task=>['queued','processing'].includes(task.status)))startCustomerRewritePolling();});}}
document.querySelectorAll('.nav-item[data-view]').forEach(n=>n.addEventListener('click',()=>selectView(n.dataset.view)));
$('#brand-home').addEventListener('click',()=>selectView('library'));
$('#nav-import').addEventListener('click',()=>selectView('imports'));
$('#imports-refresh').addEventListener('click',()=>{refreshImportTasks();refreshCustomerRewriteTasks();});
$('#imports-new').addEventListener('click',()=>$('#import-dialog').showModal());
$('#customer-rewrite-new')?.addEventListener('click',openCustomerRewrite);
$('#close-customer-rewrite')?.addEventListener('click',()=>$('#customer-rewrite-dialog').close());
$('#cancel-customer-rewrite')?.addEventListener('click',()=>$('#customer-rewrite-dialog').close());
$('#customer-rewrite-dialog')?.addEventListener('click',event=>{if(event.target===$('#customer-rewrite-dialog'))$('#customer-rewrite-dialog').close();});
$('#rewrite-choose-file')?.addEventListener('click',()=>$('#rewrite-file-input').click());
$('#rewrite-file-input')?.addEventListener('change',event=>{const file=event.target.files[0];if(file)$('#rewrite-file-name').textContent=file.name;});
$('#customer-rewrite-form')?.addEventListener('submit',submitCustomerRewrite);
$('#close-rewrite-plan')?.addEventListener('click',()=>$('#customer-rewrite-plan-dialog').close());
$('#done-rewrite-plan')?.addEventListener('click',()=>$('#customer-rewrite-plan-dialog').close());
$('#save-rewrite-plan')?.addEventListener('click',()=>saveCustomerRewritePlan(false));
$('#rerun-rewrite-plan')?.addEventListener('click',()=>saveCustomerRewritePlan(true));
$('#customer-rewrite-plan-dialog')?.addEventListener('click',event=>{if(event.target===$('#customer-rewrite-plan-dialog'))$('#customer-rewrite-plan-dialog').close();});
$('#close-rewrite-preview')?.addEventListener('click',()=>$('#customer-rewrite-preview-dialog').close());
$('#customer-rewrite-preview-dialog')?.addEventListener('click',event=>{if(event.target===$('#customer-rewrite-preview-dialog'))$('#customer-rewrite-preview-dialog').close();});
$('#close-quality').addEventListener('click',()=>$('#quality-dialog').close());
$('#done-quality').addEventListener('click',()=>$('#quality-dialog').close());
$('#quality-dialog').addEventListener('click',event=>{if(event.target===$('#quality-dialog'))$('#quality-dialog').close();});
document.querySelectorAll('.quality-tab').forEach(tab=>tab.addEventListener('click',()=>{document.querySelectorAll('.quality-tab').forEach(item=>item.classList.toggle('active',item===tab));renderQualityList(tab.dataset.qualityTab);}));
$('#ai-new-chat').addEventListener('click',newAiSession);
$('#ai-task-menu-toggle').addEventListener('click',event=>{event.stopPropagation();const menu=$('#ai-task-menu-list');const open=!menu.classList.contains('open');menu.classList.toggle('open',open);event.currentTarget.setAttribute('aria-expanded',String(open));});
document.addEventListener('click',event=>{if(!event.target.closest('.ai-task-menu')){$('#ai-task-menu-list')?.classList.remove('open');$('#ai-task-menu-toggle')?.setAttribute('aria-expanded','false');}});
document.addEventListener('click',event=>{if(!event.target.closest('#card-context-menu'))closeCardContextMenu();});
document.addEventListener('keydown',event=>{if(event.key==='Escape')closeCardContextMenu();});
$('#card-context-add-chat')?.addEventListener('click',event=>{event.stopPropagation();if(contextMenuPageId&&activeReferencePage()?.id!==contextMenuPageId)setAiReferencePage(contextMenuPageId);closeCardContextMenu();});
$('#ai-compose').addEventListener('submit',event=>{event.preventDefault();const input=$('#ai-input');const text=input.value.trim();if(!text||aiChatBusy)return;const sessionId=activeAiSessionId;input.value='';runAgentChat(text,sessionId);});
$('#ai-attach').addEventListener('click',()=>$('#ai-attach-input').click());
$('#ai-attach-input').addEventListener('change',event=>{aiAttachedSourceFile=event.target.files?.[0]||null;renderAiAttachment();});
$('#ai-input').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();$('#ai-compose').requestSubmit();}});
$('#choose-file').addEventListener('click',()=>$('#file-input').click());
$('#upload-box').addEventListener('dragover',e=>{e.preventDefault();$('#upload-box').style.borderColor='#08795f';});$('#upload-box').addEventListener('dragleave',()=>$('#upload-box').style.borderColor='');$('#upload-box').addEventListener('drop',e=>{e.preventDefault();$('#upload-box').style.borderColor='';handleFiles(e.dataTransfer.files);});$('#file-input').addEventListener('change',e=>handleFiles(e.target.files));
async function handleFiles(files){
  const valid=[...files].filter(file=>/\.pptx?$/i.test(file.name));
  if(!valid.length)return;
  const form=new FormData();valid.forEach(file=>form.append('files',file,file.name));
  try{
    const response=await fetch('/api/imports',{method:'POST',body:form});
    if(!response.ok)throw new Error(await response.text()||`上传失败（${response.status}）`);
    const payload=await response.json();
    mergeImportTasks(payload.tasks||[]);startImportPolling();
    $('#file-input').value='';
  }catch(error){window.alert(`导入任务创建失败：${error.message}`);}
}
$('#close-import').addEventListener('click',()=>$('#import-dialog').close());$('#done-import').addEventListener('click',()=>{$('#import-dialog').close();selectView('library');});
$('#close-dialog').addEventListener('click',()=>$('#label-dialog').close());
$('#label-dialog').addEventListener('click',event=>{if(event.target===$('#label-dialog'))$('#label-dialog').close();});
$('#label-dialog').addEventListener('close',()=>document.body.classList.remove('modal-open'));
$('#dialog-title').addEventListener('pointerdown',event=>{const editor=event.currentTarget;if(!editor.readOnly)return;event.preventDefault();editor.readOnly=false;editor.removeAttribute('aria-readonly');editor.focus();const end=editor.value.length;editor.setSelectionRange(end,end);});
$('#dialog-title').addEventListener('blur',event=>{event.currentTarget.readOnly=true;event.currentTarget.setAttribute('aria-readonly','true');});
$('#label-description').addEventListener('input',autosizeDescription);
$('#add-custom-tag').addEventListener('click',()=>{const input=$('#custom-tag-input');const tag=input.value.trim();if(!tag||SCENE_ENUM.includes(tag))return;CUSTOM_TAGS=[...CUSTOM_TAGS,tag];SCENE_ENUM=[...new Set([...BASE_SCENE_ENUM,...CUSTOM_TAGS])];localStorage.setItem(CUSTOM_TAG_STORAGE,JSON.stringify(CUSTOM_TAGS));const selected=[...$('#dialog-scene-tags').querySelectorAll('input:checked')].map(i=>i.value);selected.push(tag);renderSceneTags(selected);renderFilterPanel();input.value='';});
$('#custom-tag-input').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();$('#add-custom-tag').click();}});
async function runBatchAnnotation(){
  if(window.aiAnnotationBusy)return;
  const candidates=libraryPages().filter(page=>annotationState(page).key==='pending');
  if(!candidates.length)return;
  if(!window.confirm(`将提交 ${candidates.length} 页给 AI 预标注，完成后仍需人工确认。继续吗？`))return;
  window.aiAnnotationBusy=true;
  candidates.forEach(page=>{page.aiLabeling={...(page.aiLabeling||{}),status:'processing'};});
  save();renderLibrary($('#search')?.value||'');
  try{
    const response=await fetch('/api/ai/annotate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:candidates.map(page=>page.id)})});
    if(!response.ok)throw new Error(await response.text()||`请求失败（${response.status}）`);
    const payload=await response.json();
    const jobId=payload.jobId||payload.task?.id;
    candidates.forEach(page=>{page.aiLabeling={...(page.aiLabeling||{}),status:'running',jobId};});
    if(jobId){
      let taskPayload=null;
      for(let attempt=0;attempt<720;attempt++){
        await new Promise(resolve=>setTimeout(resolve,1000));
        const taskResponse=await fetch(`/api/ai/annotations/tasks/${encodeURIComponent(jobId)}`);
        if(!taskResponse.ok)throw new Error(await taskResponse.text()||`任务查询失败（${taskResponse.status}）`);
        taskPayload=await taskResponse.json();
        if(['completed','partial','failed'].includes(taskPayload.task?.status))break;
      }
      const resultResponse=await fetch(`/api/ai/annotations?ids=${encodeURIComponent(candidates.map(page=>page.id).join(','))}`);
      if(resultResponse.ok){
        const resultPayload=await resultResponse.json();
        const byId=new Map((resultPayload.items||[]).map(item=>[item.pageId,item]));
        candidates.forEach(page=>{
          const item=byId.get(page.id);const result=item?.aiLabeling?.result;
          if(result){Object.assign(page,{structureTags:result.structureTags,sceneTags:result.sceneTags,tags:result.keywords,scenarios:result.sceneTags,pageType:result.structureTags?.[0]||page.pageType,description:result.description||page.description,annotationSource:`deepseek:${item.aiLabeling.model||'model'}`,reviewStatus:'ai-pending'});page.aiLabeling=item.aiLabeling;}
          else page.aiLabeling={...(page.aiLabeling||{}),status:taskPayload?.task?.items?.[page.id]?.status==='failed'?'failed':'pending'};
        });
      }
      if(taskPayload?.task?.status==='failed')throw new Error(taskPayload.task.error||'批量标注失败');
    }else{
      candidates.forEach(page=>{page.aiLabeling={...(page.aiLabeling||{}),status:'pending'};});
    }
    save();renderFilterPanel();renderLibrary($('#search')?.value||'');renderPreviewDock();
  }catch(error){
    candidates.forEach(page=>{page.aiLabeling={...(page.aiLabeling||{}),status:'pending'};});
    save();renderLibrary($('#search')?.value||'');
    window.alert(`AI 批量预标注失败：${error.message}`);
  }finally{
    window.aiAnnotationBusy=false;renderAnnotationSummary();
  }
}
$('#ai-batch-annotate')?.addEventListener('click',runBatchAnnotation);
$('#save-label').addEventListener('click',()=>{if(!active)return;active.title=$('#dialog-title').value.trim()||'待补充标题';active.titleSource='manual';active.structureTags=[...$('#dialog-structure-tags').querySelectorAll('input:checked')].map(i=>i.value);active.sceneTags=[...$('#dialog-scene-tags').querySelectorAll('input:checked')].map(i=>i.value);active.scenarios=active.sceneTags;active.tags=$('#label-keywords').value.split(/[、,，]/).map(t=>t.trim()).filter(Boolean);active.description=$('#label-description').value.trim();active.pageType=active.structureTags[0]||'内容';active.annotationSource='manual';active.reviewStatus='confirmed';save();renderFilterPanel();renderLibrary($('#search').value);renderPreviewDock();$('#label-dialog').close();});
function openExportDialog(ids,defaultName){
  pendingExportIds=ids.filter(id=>pages.some(page=>page.id===id));
  if(!pendingExportIds.length)return;
  const input=$('#export-name');input.value=(defaultName||`PPT-Master-${pendingExportIds.length}页`).replace(/\.pptx?$/i,'');
  $('#export-dialog').showModal();input.focus();input.select();
}
async function runExport(){
  if(!pendingExportIds.length)return;
  const input=$('#export-name');const name=(input.value.trim()||`PPT-Master-${pendingExportIds.length}页`).replace(/[\\/:*?"<>|]/g,'_').replace(/\.pptx?$/i,'');
  const button=$('#confirm-export');const original=button.textContent;button.disabled=true;button.textContent='正在生成…';
  try{
    const selected=pendingExportIds.map(id=>pages.find(page=>page.id===id)).filter(Boolean);
    const generated=selected.filter(page=>page.sourceType==='ai-generated');
    const endpoint=generated.length===1&&generated.length===selected.length?`/api/ai/generated/${encodeURIComponent(generated[0].id)}/download`:`/api/export?ids=${encodeURIComponent(pendingExportIds.join(','))}`;
    const response=await fetch(endpoint);if(!response.ok)throw new Error(await response.text());const blob=await response.blob();const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download=`${name}.pptx`;link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);$('#export-dialog').close();
  }
  catch(error){window.alert(`PPT 导出失败：${error.message}`);}
  finally{button.disabled=false;button.textContent=original;}
}
$('#download-page-ppt').addEventListener('click',()=>{if(active)openExportDialog([active.id],active.title);});
$('#add-generated-page').addEventListener('click',async()=>{
  if(!active||active.sourceType!=='ai-generated'||active.libraryStatus!=='draft')return;
  const button=$('#add-generated-page');button.disabled=true;button.textContent='正在加入…';
  try{
    const response=await fetch(`/api/ai/generated/${encodeURIComponent(active.id)}/publish`,{method:'POST'});
    if(!response.ok)throw new Error(await response.text()||'加入资源库失败');
    const payload=await response.json();const updated=payload.page||active;pages=pages.map(page=>page.id===updated.id?{...page,...updated}:page);active=pages.find(page=>page.id===updated.id)||active;save();renderLibrary($('#search').value);renderPreviewDock();openLabel(active.id);
  }catch(error){window.alert(`加入资源库失败：${error.message}`);button.disabled=false;button.textContent='加入资源库';}
});
$('#cancel-export').addEventListener('click',()=>$('#export-dialog').close());
$('#confirm-export').addEventListener('click',runExport);
$('#export-name').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();runExport();}});
$('#deprecate').addEventListener('click',()=>{if(!active)return;const id=active.id;const index=draft.indexOf(id);pages=pages.filter(p=>p.id!==id);if(index>=0){draft.splice(index,1);persistPreviewOperation({type:'remove_at',index,expectedPageId:id});}save();renderLibrary($('#search').value);renderDraft();$('#label-dialog').close();});
function openPreviewLink(ids){
  const selected=ids.filter(id=>pages.some(page=>page.id===id));
  if(!selected.length)return;
  const url=new URL(window.location.href);url.searchParams.set('draft',selected.join(','));
  const tab=window.open(url.href,'_blank','noopener,noreferrer');if(!tab)window.location.href=url.href;
}
const sharedDraft=new URLSearchParams(window.location.search).get('draft');
function renderSharedPreview(ids){
  const selected=ids.map(id=>pages.find(p=>p.id===id)).filter(Boolean);
  let index=0;
  const image=$('#shared-preview-image'),caption=$('#shared-preview-caption'),counter=$('#shared-preview-counter'),prev=$('#shared-preview-prev'),next=$('#shared-preview-next'),thumbs=$('#shared-preview-thumbs');
  const paint=()=>{const page=selected[index];if(!page)return;image.src=page.preview||'';image.alt=page.title||`第 ${index+1} 页`;caption.textContent=page.title||'';counter.textContent=`${index+1} / ${selected.length}`;prev.disabled=index===0;next.disabled=index===selected.length-1;thumbs.querySelectorAll('button').forEach((button,i)=>button.classList.toggle('active',i===index));};
  thumbs.innerHTML=selected.map((page,i)=>`<button data-shared-index="${i}" aria-label="第 ${i+1} 页"><img src="${page.preview||''}" alt=""></button>`).join('');
  thumbs.querySelectorAll('button').forEach(button=>button.addEventListener('click',()=>{index=Number(button.dataset.sharedIndex);paint();}));
  prev.addEventListener('click',()=>{if(index>0){index--;paint();}});next.addEventListener('click',()=>{if(index<selected.length-1){index++;paint();}});
  $('#shared-preview-close').addEventListener('click',()=>{const url=new URL(window.location.href);url.searchParams.delete('draft');window.location.href=url.href;});
  $('#shared-slideshow').addEventListener('click',async()=>{
    document.body.classList.add('slideshow-mode');
    try{await document.documentElement.requestFullscreen?.();}
    catch{document.body.classList.remove('slideshow-mode');}
  });
  document.addEventListener('fullscreenchange',()=>{if(!document.fullscreenElement)document.body.classList.remove('slideshow-mode');});
  document.addEventListener('keydown',event=>{if(event.key==='ArrowLeft'&&index>0){index--;paint();}if(event.key==='ArrowRight'&&index<selected.length-1){index++;paint();}if(event.key==='Escape'&&!document.fullscreenElement)$('#shared-preview-close').click();});
  paint();
}
async function refreshGeneratedPages(){
  try{
    const response=await fetch('/api/ai/generated');if(!response.ok)return;
    const payload=await response.json();
    for(const page of payload.items||[])if(page?.id&&!pages.some(item=>item.id===page.id))pages.push(page);
    if((payload.items||[]).length)save();
  }catch{}
}
refreshGeneratedPages().finally(async()=>{
  if(sharedDraft){
    const sharedIds=sharedDraft.split(',').filter(Boolean);
    await fetchPageRecords(sharedIds).catch(error=>console.warn(error.message));
    draft=sharedIds.filter(id=>pages.some(p=>p.id===id));
    document.body.classList.add('shared-preview-mode');
    renderSharedPreview(draft);
  }
  renderFilterPanel();renderPreviewDock();renderLibrary();renderQueue();renderImportHistory();renderCustomerRewriteTasks();renderDraft();renderAiPanel();bootstrapPreviewSession();refreshImportTasks().then(startImportPolling);loadLibraryPage(1);
});

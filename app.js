'use strict';
/* WerkStandaard Team v3 – team verwijderen en optionele gebruikersnaam-aanmelding. */
const $ = id => document.getElementById(id);
const uuid = () => crypto.randomUUID();
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const asLines = value => escapeHTML(value).replace(/\n/g,'<br>');
const dateNL = value => value ? new Date(value).toLocaleDateString('nl-NL',{day:'numeric',month:'short',year:'numeric'}) : '';
const isoDate = value => value ? new Date(value+'T12:00:00').toLocaleDateString('nl-NL') : '';
const isUuid = text => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(text||'').trim());
const imgData = str => typeof str === 'string' && /^data:image\/(jpeg|png|webp);base64,[a-z0-9+/=]+$/i.test(str);
const errMsg = error => error?.message || 'Er is iets misgegaan';
const withResult = ({data,error}) => { if(error) throw error; return data; };
const BUCKET='werkstandaard-team-fotos';
let client,user,team,members=[],tasks=[],photos=[],signedPhotos={},currentRole='',activeTaskId=null,editingId=null,authMode='login',page='tasks',refreshInProgress=false;
const show = (id, visible=true) => $(id).classList.toggle('hidden',!visible);
let noticeTimer;
function toast(message){const el=$('toast'); el.textContent=message;el.classList.add('show');clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>el.classList.remove('show'),3900);}
function friendlyError(error){console.error(error);toast(errMsg(error));}
function busy(el,state,text){if (!el) return; if(state){el.dataset.original=el.textContent;el.disabled=true;if(text)el.textContent=text;}else{el.disabled=false;if(el.dataset.original){el.textContent=el.dataset.original;delete el.dataset.original;}}}
function showTop(section){['setupView','authView','workspaceView','mainView'].forEach(id=>show(id,id===section));show('bottomNav',section==='mainView');show('signoutBtn',Boolean(user) && section!=='setupView');}
function ownMembership(){return members.find(m=>m.user_id===user?.id && m.team_id===team?.id);}
function isAdmin(){return currentRole==='admin';}
function canWork(task){return isAdmin() || !task.assigned_to || task.assigned_to===user.id;}
function memberName(id){if(!id)return 'Niet toegewezen';return members.find(m=>m.user_id===id)?.display_name || 'Medewerker';}
function statusLabel(status){return ({todo:'Open',doing:'In uitvoering',done:'Afgerond'})[status]||'Open';}
function score(task){const checks=Array.isArray(task.checks)?task.checks:[];const count=checks.filter(c=>c.done===true).length;return {done:count,total:checks.length,pct:checks.length?Math.round(count/checks.length*100):0};}
function selectedTeamName(){return localStorage.getItem('ws_team_id');}
function displayName(){return String(user?.user_metadata?.display_name||localStorage.getItem('ws_display_name')||user?.user_metadata?.username||user?.email?.split('@')[0]||'Medewerker').slice(0,70);}
// Supabase Auth gebruikt intern nog een e-mail-ID, maar de medewerker vult alleen
// een gebruikersnaam in. example.com is een gereserveerd voorbeelddomein.
function resolveLoginIdentifier(raw){
 const value=String(raw||'').trim().toLowerCase();
 if(value.includes('@')){
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))throw new Error('Vul een geldig e-mailadres in.');
  return {email:value,username:null};
 }
 if(!/^[a-z0-9][a-z0-9_-]{2,31}$/.test(value))throw new Error('Een gebruikersnaam bestaat uit 3–32 letters, cijfers, - of _. Begin met een letter of cijfer.');
 return {email:`ws-${value}@example.com`,username:value};
}
async function start(){
 const config=window.WERKSTANDAARD_CONFIG||{};
 if(!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test((config.supabaseUrl||'').trim()) || !(config.publishableKey||'').trim()){showTop('setupView');return;}
 if(!window.supabase?.createClient){showTop('setupView');$('setupView').querySelector('p').textContent='De Supabase-bibliotheek is niet geladen. Controleer je internetverbinding of de browserinstellingen.';return;}
 try{
  client=window.supabase.createClient(config.supabaseUrl.trim(),config.publishableKey.trim(),{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
  const {data,error}=await client.auth.getUser();if(error)console.warn(error);user=data?.user||null;
  if(user)await workspace();else showAuth();
  client.auth.onAuthStateChange((event,session)=>{if(event==='SIGNED_OUT'){user=null;team=null;tasks=[];showAuth();}});
  if('serviceWorker' in navigator && location.protocol==='https:')navigator.serviceWorker.register('./sw.js').catch(console.warn);
 }catch(error){friendlyError(error);showAuth();}
}
function showAuth(){showTop('authView');$('authPass').value='';$('authIdentifier').value='';}
function toggleAuth(){
 authMode=authMode==='login'?'register':'login';
 $('authSubmit').textContent=authMode==='login'?'Inloggen':'Registreren';
 $('switchAuth').textContent=authMode==='login'?'Nog geen account? Registreren':'Heb je een account? Inloggen';
 $('authName').closest('label').classList.toggle('hidden',authMode!=='register');
 $('authName').required=authMode==='register';
 $('authPass').autocomplete=authMode==='register'?'new-password':'current-password';
 $('authHelp').textContent=authMode==='register'
  ?'Kies bij voorkeur een unieke gebruikersnaam en een sterk wachtwoord (minimaal 10 tekens). Geen echt e-mailadres nodig. Vraag daarna toegang tot je team.'
  :'Inloggen kan met gebruikersnaam of met je bestaande e-mailadres. Een account zonder echt e-mailadres heeft geen e-mailwachtwoordherstel.';
} 
async function submitAuth(e){e.preventDefault();const btn=$('authSubmit');busy(btn,true,'Even controleren…');try{
 const {email,username}=resolveLoginIdentifier($('authIdentifier').value),password=$('authPass').value;
 if(authMode==='register'){
  const name=$('authName').value.trim();if(name.length<2)throw new Error('Vul je naam in (minstens twee tekens).');
  if(password.length<10)throw new Error('Kies voor nieuwe accounts een wachtwoord met minimaal 10 tekens.');
  localStorage.setItem('ws_display_name',name);
  const result=withResult(await client.auth.signUp({email,password,options:{data:{display_name:name,...(username?{username}:{})},emailRedirectTo:location.origin+location.pathname}}));
  if(result.session){user=result.user;await workspace();}
  else if(username){throw new Error('Supabase vraagt nog e-mailbevestiging. Zet Authentication → Providers → Email → Confirm Email uit om gebruikersnaamaccounts te registreren.');}
  else{toast('Account gemaakt. Bevestig eerst je e-mailadres en log daarna in.');toggleAuth();}
 }else{
  const result=withResult(await client.auth.signInWithPassword({email,password}));user=result.user;await workspace();
 }
}catch(error){friendlyError(error);}finally{busy(btn,false);}}
async function workspace(autoOpen=true){
 if(!user){showAuth();return;}
 showTop('workspaceView');
 try{
  const rows=withResult(await client.from('ws_memberships').select('team_id,user_id,display_name,role,status').eq('user_id',user.id));
  const active=rows.filter(m=>m.status==='active');let teamsById={};
  if(active.length){const teamRows=withResult(await client.from('ws_teams').select('id,name,created_by,deleting_at').in('id',active.map(m=>m.team_id)));teamsById=Object.fromEntries(teamRows.map(t=>[t.id,t]));}
  $('teamList').innerHTML=rows.length?rows.map(m=>{
   const t=teamsById[m.team_id];
   const action=t?.deleting_at?(t.created_by===user.id?`<button type="button" class="button danger" data-resume-delete="${escapeHTML(m.team_id)}">Verwijderen afronden</button>`:'<span class="chip doing">Wordt verwijderd</span>'):m.status==='active'?`<button type="button" class="button primary" data-open-team="${escapeHTML(m.team_id)}">Open team</button>`:'<span class="chip doing">In afwachting</span>';
   return `<div class="team-choice"><div><h3>${escapeHTML(t?.name||'Toegangsaanvraag')}</h3><p>${t?.deleting_at?'Verwijderen nog niet voltooid':m.status==='pending'?'Wacht op goedkeuring door beheerder':m.role==='admin'?'Beheerder':'Medewerker'}</p></div>${action}</div>`;
  }).join(''):'<div class="empty">Je bent nog niet aangesloten bij een team. Maak een team of vraag toegang aan.</div>';
  const invite=new URL(location.href).searchParams.get('team');if(isUuid(invite))$('joinTeamId').value=invite;
  const saved=selectedTeamName();if(autoOpen&&saved&&active.some(m=>m.team_id===saved)&&teamsById[saved])await openTeam(saved);
 }catch(error){friendlyError(error);}
}
async function makeTeam(e){e.preventDefault();const btn=e.submitter;busy(btn,true,'Team maken…');try{
 const teamId=withResult(await client.rpc('ws_create_team',{p_name:$('newTeamName').value.trim(),p_display_name:displayName()}));
 toast('Team gemaakt');await openTeam(teamId);
}catch(error){friendlyError(error);}finally{busy(btn,false);}}
async function joinTeam(e){e.preventDefault();const btn=e.submitter;busy(btn,true,'Aanvragen…');try{
 const id=$('joinTeamId').value.trim();if(!isUuid(id))throw new Error('Vul een geldige teamcode in.');
 await withResult(await client.rpc('ws_request_join',{p_team:id,p_display_name:displayName()}));
 toast('Aanvraag verstuurd. De beheerder moet je goedkeuren.');await workspace(false);
}catch(error){friendlyError(error);}finally{busy(btn,false);}}
async function openTeam(teamId){
 try{
  team=withResult(await client.from('ws_teams').select('id,name,created_by,deleting_at').eq('id',teamId).single());
  if(team.deleting_at)throw new Error('Dit team wordt verwijderd. De maker kan de verwijdering afronden.');
  localStorage.setItem('ws_team_id',teamId);
  await loadMembers();
  if(!ownMembership()||ownMembership().status!=='active')throw new Error('Je hebt nog geen toegang tot dit team.');
  currentRole=ownMembership().role;
  $('teamTitle').textContent=team.name;
  $('headerSubtitle').textContent=team.name;
  $('myRole').textContent=isAdmin()?'Beheerder · taken maken en verdelen':'Medewerker · taken uitvoeren';
  show('createTask',isAdmin());showTop('mainView');tab('tasks');await loadTasks();
 }catch(error){friendlyError(error);await workspace(false);}
}
async function loadMembers(){members=withResult(await client.from('ws_memberships').select('team_id,user_id,display_name,role,status').eq('team_id',team.id).order('display_name'));}
async function loadTasks(){if(!team||refreshInProgress)return;refreshInProgress=true;try{
 tasks=withResult(await client.from('ws_tasks').select('*').eq('team_id',team.id).order('created_at',{ascending:false}));renderTasks();
 if(activeTaskId&&$('detailDialog').open){const t=tasks.find(t=>t.id===activeTaskId);if(t)renderDetail(t);}
}catch(error){friendlyError(error);}finally{refreshInProgress=false;}}
function renderTasks(){
 $('countAll').textContent=tasks.length;$('countOpen').textContent=tasks.filter(t=>t.status==='todo').length;
 $('countMine').textContent=tasks.filter(t=>t.assigned_to===user.id&&t.status!=='done').length;
 $('countDone').textContent=tasks.filter(t=>t.status==='done').length;
 const q=$('taskSearch').value.trim().toLocaleLowerCase('nl'),scope=$('taskScope').value,status=$('taskStatus').value;
 const filtered=tasks.filter(t=>(status==='all'||status===t.status) && (scope==='all'||(scope==='mine'&&t.assigned_to===user.id)||(scope==='unassigned'&&!t.assigned_to)) && [t.title,t.machine,t.category,t.frequency].join(' ').toLocaleLowerCase('nl').includes(q));
 $('taskList').innerHTML=filtered.length?filtered.map(t=>{const p=score(t);return `<button type="button" class="task-card" data-task="${escapeHTML(t.id)}"><div class="row-between"><span class="chip ${escapeHTML(t.status)}">${statusLabel(t.status)}</span><span class="small">${escapeHTML(t.category)}</span></div><h3>${escapeHTML(t.title)}</h3><p>⚙ ${escapeHTML(t.machine||'Geen machine opgegeven')}</p><p>👤 ${escapeHTML(memberName(t.assigned_to))}${t.due_date?' · 📅 '+escapeHTML(isoDate(t.due_date)):''}</p><div class="progress-track"><span style="width:${p.pct}%"></span></div><div class="row-between"><span class="subtle">${p.done}/${p.total} checkpunten</span><span class="subtle">Openen ↗</span></div></button>`;}).join(''):'<div class="empty">Geen taken gevonden voor dit filter.</div>';
}
function tab(target){page=target;['tasks','team','backup'].forEach(name=>{show(name==='tasks'?'tasksPage':name==='team'?'teamPage':'backupPage',name===target);document.querySelector(`[data-tab="${name}"]`).classList.toggle('active',name===target);});if(target==='team')renderTeam().catch(friendlyError);}
async function renderTeam(){if(!team)return;await loadMembers();const me=ownMembership();currentRole=me?.role||'member';
 const url=new URL(location.origin+location.pathname);url.searchParams.set('team',team.id);$('inviteLink').value=url.href;$('teamCode').textContent=team.id;
 show('deleteTeamPanel',team.created_by===user.id);
 $('memberList').innerHTML=members.map(m=>`<div class="member-row"><div><h3>${escapeHTML(m.display_name)}${m.user_id===user.id?' (jij)':''}</h3><p>${m.role==='admin'?'Beheerder':'Medewerker'} · ${m.status==='active'?'Actief':'Wacht op goedkeuring'}</p></div>${isAdmin()&&m.status==='pending'?`<div class="row-between"><button type="button" class="button primary" data-approve="${escapeHTML(m.user_id)}">Goedkeuren</button><button type="button" class="button danger" data-reject="${escapeHTML(m.user_id)}">Afwijzen</button></div>`:''}</div>`).join('');
}
// Definitief verwijderen: eerst het team blokkeren, dan alle Storage-objecten via
// de Storage-API verwijderen, vervolgens de SQL-records transactioneel opruimen.
// Mislukt de procedure tussendoor, dan kan de maker hem vanuit Teamkeuze hervatten.
async function removeTeam(teamId){
 const button=$('deleteTeamBtn');
 try{
  const t=withResult(await client.from('ws_teams').select('id,name,created_by,deleting_at').eq('id',teamId).single());
  if(t.created_by!==user?.id)throw new Error('Alleen de maker van het team mag het definitief verwijderen.');
  const entered=prompt(`Definitief verwijderen van team “${t.name}”?\n\nDownload EERST een back-up via het tabblad Back-up.\n\nTyp de volledige teamnaam om verder te gaan:`);
  if(entered===null)return;
  if(entered.trim()!==t.name){toast('Teamnaam komt niet overeen. Er is niets verwijderd.');return;}
  if(!confirm(`Alle taken, checklists, teamleden en foto's van “${t.name}” worden DEFINITIEF verwijderd voor iedereen. Dit kan niet ongedaan worden gemaakt. Doorgaan?`))return;
  busy(button,true,'Team verwijderen…');
  await withResult(await client.rpc('ws_begin_delete_team',{p_team:t.id}));
  let loops=0;
  while(true){
   if(++loops>2000)throw new Error('De opruimactie is onderbroken: te veel bestanden. Probeer opnieuw.');
   const paths=withResult(await client.rpc('ws_next_delete_photo_paths',{p_team:t.id,p_limit:100}));
   if(!Array.isArray(paths)||paths.length===0)break;
   await withResult(await client.storage.from(BUCKET).remove(paths));
  }
  await withResult(await client.rpc('ws_finish_delete_team',{p_team:t.id}));
  if(team?.id===t.id){team=null;members=[];tasks=[];photos=[];activeTaskId=null;}
  if(selectedTeamName()===t.id)localStorage.removeItem('ws_team_id');
  toast('Team met taken en foto’s definitief verwijderd');
  await workspace(false);
 }catch(error){friendlyError(error);await workspace(false);}
 finally{busy(button,false);}
}
async function reviewMember(id,approve){if(!confirm(approve?'Deze medewerker toegang geven tot alle teamtaken?':'Deze aanvraag afwijzen?'))return;try{
 await withResult(await client.rpc('ws_review_member',{p_team:team.id,p_user:id,p_approve:approve}));toast(approve?'Medewerker toegelaten':'Aanvraag afgewezen');await renderTeam();
}catch(error){friendlyError(error);}}
function appendRow(which,item={}){const el=document.createElement('div');el.className='editable-row';el.dataset.id=item.id||uuid();
 el.innerHTML=which==='step'?`<textarea rows="2" class="step-text" placeholder="Beschrijving van de stap" maxlength="2000">${escapeHTML(item.text||'')}</textarea><button type="button" class="remove-row" aria-label="Verwijderen">✕</button>`:`<input class="check-text" maxlength="450" placeholder="Wat moet gecontroleerd worden?" value="${escapeHTML(item.text||'')}"><button type="button" class="remove-row" aria-label="Verwijderen">✕</button>`;
 el.dataset.done=item.done?'true':'false';$(which==='step'?'editSteps':'editChecks').append(el);
}
function editTask(id=null){if(!isAdmin()){toast('Alleen de beheerder mag taken wijzigen.');return;}const t=id?tasks.find(t=>t.id===id):null;editingId=t?.id||null;
 $('taskDialogTitle').textContent=t?'Taak aanpassen':'Nieuwe onderhoudstaak';$('editTitle').value=t?.title||'';$('editMachine').value=t?.machine||'';$('editCategory').value=t?.category||'Inspectie';$('editFrequency').value=t?.frequency||'';$('editDue').value=t?.due_date||'';$('editSafety').value=t?.safety||'';$('editTools').value=t?.tools||'';
 $('editAssignee').innerHTML='<option value="">Nog niet toegewezen</option>'+members.filter(m=>m.status==='active').map(m=>`<option value="${escapeHTML(m.user_id)}">${escapeHTML(m.display_name)}</option>`).join('');$('editAssignee').value=t?.assigned_to||'';
 $('editSteps').replaceChildren();$('editChecks').replaceChildren();(t?.steps?.length?t.steps:[{}]).forEach(s=>appendRow('step',s));(t?.checks?.length?t.checks:[{}]).forEach(c=>appendRow('check',c));$('taskDialog').showModal();}
async function submitTask(e){e.preventDefault();const btn=$('saveTask');busy(btn,true,'Opslaan…');try{
 const old=editingId?tasks.find(t=>t.id===editingId):null;
 const steps=[...$('editSteps').children].map(el=>({id:el.dataset.id,text:el.querySelector('.step-text').value.trim()})).filter(s=>s.text);
 let checks=[...$('editChecks').children].map(el=>{const prev=(old?.checks||[]).find(c=>c.id===el.dataset.id)||{};return {...prev,id:el.dataset.id,text:el.querySelector('.check-text').value.trim(),done:prev.done===true};}).filter(c=>c.text);
 const record={title:$('editTitle').value.trim(),machine:$('editMachine').value.trim(),category:$('editCategory').value,frequency:$('editFrequency').value.trim(),due_date:$('editDue').value||null,assigned_to:$('editAssignee').value||null,safety:$('editSafety').value.trim(),tools:$('editTools').value.trim(),steps,checks};
 if(!record.title)throw new Error('Geef de taak een naam.');
 // Bij een gewijzigde checklist moet de taak opnieuw worden uitgevoerd.
 if(old && JSON.stringify((old.checks||[]).map(c=>[c.id,c.text]))!==JSON.stringify(checks.map(c=>[c.id,c.text]))) {
   checks=checks.map(c=>({...c,done:false,doneBy:null,doneAt:null}));record.checks=checks;
   record.status='todo';record.completed_by=null;record.completed_at=null;
 }
 let saved;if(old){saved=withResult(await client.from('ws_tasks').update(record).eq('id',old.id).eq('team_id',team.id).select('id').single());}
 else{saved=withResult(await client.from('ws_tasks').insert({...record,team_id:team.id,created_by:user.id}).select('id').single());}
 $('taskDialog').close();await loadTasks();toast(old?'Taak aangepast':'Taak gemaakt');await openTask(saved.id);
 }catch(error){friendlyError(error);}finally{busy(btn,false);}}
async function openTask(id){const t=tasks.find(t=>t.id===id);if(!t)return;activeTaskId=id;photos=[];signedPhotos={};renderDetail(t);$('detailDialog').showModal();await fetchPhotos(id);}
async function fetchPhotos(id){try{
 photos=withResult(await client.from('ws_photos').select('*').eq('task_id',id).eq('team_id',team.id).order('created_at',{ascending:false}));signedPhotos={};
 if(photos.length){const paths=photos.map(p=>p.storage_path);const links=withResult(await client.storage.from(BUCKET).createSignedUrls(paths,600));links.forEach((link,i)=>{if(link?.signedUrl)signedPhotos[paths[i]]=link.signedUrl;});}
 if(activeTaskId===id&&$('detailDialog').open)renderDetail(tasks.find(t=>t.id===id));
}catch(error){friendlyError(error);}}
function renderDetail(t){if(!t)return;const p=score(t),editable=canWork(t),mine=editable;const taskPhotos=photos.filter(f=>f.task_id===t.id);
 $('detailTitle').textContent=t.title;show('editCurrent',isAdmin());
 const details=`<div class="detail-grid"><span>⚙ ${escapeHTML(t.machine||'Algemeen')}</span><span>👤 ${escapeHTML(memberName(t.assigned_to))}</span><span>◷ ${escapeHTML(t.frequency||'Geen frequentie')}</span>${t.due_date?`<span>📅 Uiterlijk ${escapeHTML(isoDate(t.due_date))}</span>`:''}<span class="chip ${escapeHTML(t.status)}">${statusLabel(t.status)}</span></div>`;
 const status=mine?`<div class="detail-block"><h3>Uitvoering</h3><label>Status<select id="detailStatus"><option value="todo" ${t.status==='todo'?'selected':''}>Open</option><option value="doing" ${t.status==='doing'?'selected':''}>In uitvoering</option><option value="done" ${t.status==='done'?'selected':''}>Afgerond</option></select></label><p class="small">Een taak kan pas worden afgerond als alle checklistpunten zijn afgevinkt.</p></div>`:`<div class="notice">Deze taak is toegewezen aan ${escapeHTML(memberName(t.assigned_to))}. Je kunt de instructies bekijken, maar niet afvinken.</div>`;
 const steps=(t.steps||[]).map((s,i)=>{const pics=taskPhotos.filter(photo=>photo.step_id===s.id&&signedPhotos[photo.storage_path]);return `<div class="instruction"><strong>${i+1}</strong><div><p>${asLines(s.text)}</p>${pics.length?`<div class="step-images">${pics.map(photo=>`<a href="${escapeHTML(signedPhotos[photo.storage_path])}" target="_blank" rel="noopener"><img src="${escapeHTML(signedPhotos[photo.storage_path])}" alt="${escapeHTML(photo.caption||'Foto bij instructiestap')}"></a>`).join('')}</div>`:''}</div></div>`;}).join('')||'<p class="muted">Geen instructiestappen toegevoegd.</p>';
 const checks=(t.checks||[]).map(c=>`<label class="check-item"><input type="checkbox" data-check-id="${escapeHTML(c.id)}" ${c.done?'checked':''} ${!editable?'disabled':''}><span>${asLines(c.text)}</span></label>`).join('')||'<p class="muted">Nog geen checklist toegevoegd.</p>';
 const gallery=taskPhotos.length?`<div class="photos">${taskPhotos.map(photo=>`<div class="photo-card">${signedPhotos[photo.storage_path]?`<a href="${escapeHTML(signedPhotos[photo.storage_path])}" target="_blank" rel="noopener"><img loading="lazy" src="${escapeHTML(signedPhotos[photo.storage_path])}" alt="${escapeHTML(photo.caption||'Onderhoudsfoto')}"></a>`:'<div class="muted">Foto laden…</div>'}<div>${escapeHTML(photo.caption||'Onderhoudsfoto')}<small>${escapeHTML(memberName(photo.uploaded_by))}</small>${(isAdmin()||photo.uploaded_by===user.id)?`<button type="button" class="text-button" data-delete-photo="${escapeHTML(photo.id)}">Verwijderen</button>`:''}</div></div>`).join('')}</div>`:'<p class="muted">Nog geen foto’s toegevoegd.</p>';
 $('detailBody').innerHTML=details+status+(t.safety?`<div class="detail-block safety"><h3>⚠ Veiligheidsvoorwaarden</h3><p>${asLines(t.safety)}</p></div>`:'')+(t.tools?`<div class="detail-block"><h3>Gereedschap en materiaal</h3><p>${asLines(t.tools)}</p></div>`:'')+`<div class="detail-block"><h3>Standaardwerkinstructie</h3>${steps}</div><div class="detail-block"><h3>Checklist · ${p.done}/${p.total}</h3><div class="progress-track"><span style="width:${p.pct}%"></span></div>${checks}</div><div class="detail-block"><div class="row-between"><h3>Foto's · ${taskPhotos.length}</h3>${editable?'<button type="button" class="button secondary" id="openPhoto">＋ Foto</button>':''}</div>${gallery}</div>${isAdmin()?'<div class="row-between"><span class="small">Alleen de beheerder kan een taak wissen.</span><button type="button" id="deleteCurrent" class="button danger">Taak verwijderen</button></div>':''}`;
}
async function changeCheck(id,done){const t=tasks.find(t=>t.id===activeTaskId);if(!t)return;try{
 await withResult(await client.rpc('ws_set_check',{p_task:t.id,p_check_id:id,p_done:done}));await loadTasks();
}catch(error){friendlyError(error);renderDetail(t);}}
async function changeStatus(status){const t=tasks.find(t=>t.id===activeTaskId);if(!t)return;try{
 await withResult(await client.rpc('ws_set_status',{p_task:t.id,p_status:status}));await loadTasks();toast('Status opgeslagen');
}catch(error){friendlyError(error);renderDetail(t);}}
function showPhotoForm(){const t=tasks.find(t=>t.id===activeTaskId);if(!t||!canWork(t))return; $('photoForm').reset();$('photoStep').innerHTML='<option value="">Algemene foto</option>'+(t.steps||[]).map((s,i)=>`<option value="${escapeHTML(s.id)}">Stap ${i+1}: ${escapeHTML(s.text.slice(0,50))}</option>`).join('');$('photoDialog').showModal();}
function compressedJpeg(file){return new Promise((resolve,reject)=>{
 if(!String(file.type).startsWith('image/'))return reject(new Error('Kies een afbeelding.'));
 if(file.size>40*1024*1024)return reject(new Error('Foto is te groot (maximaal 40 MB invoer).'));
 const url=URL.createObjectURL(file),img=new Image();img.onload=()=>{try{
  const ratio=Math.min(1,1600/Math.max(img.naturalWidth,img.naturalHeight)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(img.naturalWidth*ratio));canvas.height=Math.max(1,Math.round(img.naturalHeight*ratio));const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(img,0,0,canvas.width,canvas.height);
  canvas.toBlob(blob=>{URL.revokeObjectURL(url);canvas.width=canvas.height=0;if(blob)resolve(blob);else reject(new Error('Foto omzetten mislukt'));},'image/jpeg',.72);
 }catch(error){URL.revokeObjectURL(url);reject(error);}};img.onerror=()=>{URL.revokeObjectURL(url);reject(new Error('Foto kan niet worden geopend'));};img.src=url;
});}
async function uploadPhotoBlob(taskId,blob,caption='',stepId=''){
 const path=`${team.id}/${taskId}/${uuid()}.jpg`;
 await withResult(await client.storage.from(BUCKET).upload(path,blob,{contentType:'image/jpeg',upsert:false}));
 try{
  await withResult(await client.from('ws_photos').insert({team_id:team.id,task_id:taskId,storage_path:path,caption,step_id:stepId,uploaded_by:user.id}));
 }catch(error){await client.storage.from(BUCKET).remove([path]).catch(console.warn);throw error;}
}
async function submitPhoto(e){e.preventDefault();const btn=$('savePhoto');busy(btn,true,'Foto uploaden…');try{
 const file=$('photoFile').files?.[0];if(!file)throw new Error('Kies eerst een foto.');const blob=await compressedJpeg(file);await uploadPhotoBlob(activeTaskId,blob,$('photoCaption').value.trim(),$('photoStep').value);
 $('photoDialog').close();await fetchPhotos(activeTaskId);toast('Foto gedeeld met je team');
}catch(error){friendlyError(error);}finally{busy(btn,false);}}
async function deletePhoto(photoId){const p=photos.find(p=>p.id===photoId);if(!p||!confirm('Deze foto definitief voor het hele team verwijderen?'))return;try{
 await withResult(await client.storage.from(BUCKET).remove([p.storage_path]));await withResult(await client.from('ws_photos').delete().eq('id',photoId));await fetchPhotos(activeTaskId);toast('Foto verwijderd');
}catch(error){friendlyError(error);}}
async function deleteTask(){const t=tasks.find(t=>t.id===activeTaskId);if(!t||!isAdmin()||!confirm(`Taak “${t.title}” met alle bijbehorende foto's verwijderen voor iedereen?`))return;try{
 const rows=withResult(await client.from('ws_photos').select('storage_path').eq('task_id',t.id));if(rows.length){await withResult(await client.storage.from(BUCKET).remove(rows.map(r=>r.storage_path)));}
 await withResult(await client.from('ws_tasks').delete().eq('id',t.id).eq('team_id',team.id));$('detailDialog').close();activeTaskId=null;await loadTasks();toast('Taak verwijderd');
}catch(error){friendlyError(error);}}
async function importOld(e){const file=e.target.files?.[0];e.target.value='';if(!file)return;if(!isAdmin()){toast('Alleen een beheerder kan taken importeren.');return;}
 if(!confirm('Deze back-up toevoegen aan je team? Doe dit bij voorkeur één keer.'))return;
 const label=$('importLabel');label.style.opacity='.6';toast('Back-up importeren…');let count=0,skipped=0,pics=0,failedPhotos=0;
 try{
  const backup=JSON.parse(await file.text());if(backup.app!=='WerkStandaard'||!Array.isArray(backup.tasks))throw new Error('Dit is geen WerkStandaard-back-up.');
  if(backup.tasks.length>250)throw new Error('Importeer maximaal 250 taken per bestand.');
  for(const old of backup.tasks){
   if(!old||!String(old.title||'').trim())continue;
   const title=String(old.title).slice(0,150).trim(),machine=String(old.machine||'').slice(0,150);
   if(tasks.some(t=>t.title.toLowerCase()===title.toLowerCase() && t.machine.toLowerCase()===machine.toLowerCase())){skipped++;continue;}
   const steps=(Array.isArray(old.steps)?old.steps:[]).slice(0,150).filter(s=>s?.text).map(s=>({id:String(s.id||uuid()).slice(0,130),text:String(s.text).slice(0,2000)}));
   const checks=(Array.isArray(old.checks)?old.checks:[]).slice(0,150).filter(c=>c?.text).map(c=>({id:String(c.id||uuid()).slice(0,130),text:String(c.text).slice(0,450),done:c.done===true}));
   const row={team_id:team.id,created_by:user.id,title,machine,category:String(old.category||'Inspectie').slice(0,100),frequency:String(old.frequency||'').slice(0,100),tools:String(old.tools||'').slice(0,3000),safety:String(old.safety||'').slice(0,3000),steps,checks};
   const task=withResult(await client.from('ws_tasks').insert(row).select('id').single());count++;tasks.push({...row,id:task.id,status:'todo'});
   for(const photo of (Array.isArray(old.photos)?old.photos:[]).slice(0,75)){
    if(!imgData(photo?.data))continue;
    try{const blob=await compressedJpeg(await (await fetch(photo.data)).blob());await uploadPhotoBlob(task.id,blob,String(photo.caption||'').slice(0,150),String(photo.stepId||''));pics++;}catch(error){failedPhotos++;console.warn('Foto importeren mislukt',error);}
   }
  }
  await loadTasks();toast(`${count} taken en ${pics} foto's toegevoegd. ${skipped} overgeslagen${failedPhotos?`, ${failedPhotos} foto's mislukt`:''}.`);
 }catch(error){friendlyError(error);}finally{label.style.opacity='';}
}
function downloadJson(object,name){const data=new Blob([JSON.stringify(object)],{type:'application/json'}),url=URL.createObjectURL(data),link=document.createElement('a');link.href=url;link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}
function blobDataUrl(blob){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error);reader.readAsDataURL(blob);});}
async function exportAll(){const btn=$('exportAll');busy(btn,true,'Back-up maken…');try{
 const all=withResult(await client.from('ws_tasks').select('*').eq('team_id',team.id));const rows=withResult(await client.from('ws_photos').select('*').eq('team_id',team.id));
 if(rows.length>100&&!confirm(`${rows.length} foto's opnemen? Dit kan een groot bestand worden. Ga door?`))return;
 const output=[];for(const t of all){const taskPhotos=[];for(const photo of rows.filter(p=>p.task_id===t.id)){
  const blob=withResult(await client.storage.from(BUCKET).download(photo.storage_path));const data=await blobDataUrl(blob);taskPhotos.push({id:photo.id,caption:photo.caption,stepId:photo.step_id,data});
 }
 output.push({title:t.title,machine:t.machine,category:t.category,frequency:t.frequency,tools:t.tools,safety:t.safety,steps:t.steps,checks:t.checks,photos:taskPhotos,assigned_to:t.assigned_to,due_date:t.due_date,status:t.status});
 }
 downloadJson({app:'WerkStandaard',version:2,exportedAt:new Date().toISOString(),teamName:team.name,tasks:output},`WerkStandaard-Team-backup-${new Date().toISOString().slice(0,10)}.json`);toast('Team-back-up gedownload');
}catch(error){friendlyError(error);}finally{busy(btn,false);}}
function copyInvite(){navigator.clipboard?.writeText($('inviteLink').value).then(()=>toast('Uitnodigingslink gekopieerd')).catch(()=>{ $('inviteLink').select();toast('Selecteer en kopieer de link.');});}
function attachEvents(){
 $('authForm').addEventListener('submit',submitAuth);$('switchAuth').addEventListener('click',toggleAuth);$('authName').closest('label').classList.add('hidden');
 $('signoutBtn').addEventListener('click',async()=>{try{if(client)await client.auth.signOut();user=null;team=null;showAuth();}catch(error){friendlyError(error);}});
 $('newTeamForm').addEventListener('submit',makeTeam);$('joinTeamForm').addEventListener('submit',joinTeam);
 $('teamList').addEventListener('click',e=>{const b=e.target.closest('[data-open-team]');if(b)openTeam(b.dataset.openTeam);const d=e.target.closest('[data-resume-delete]');if(d)removeTeam(d.dataset.resumeDelete);});
 $('deleteTeamBtn').addEventListener('click',()=>{if(team)removeTeam(team.id);});
 $('changeTeam').addEventListener('click',()=>workspace(false));$('createTask').addEventListener('click',()=>editTask());$('refreshTasks').addEventListener('click',loadTasks);
 $('taskSearch').addEventListener('input',renderTasks);$('taskScope').addEventListener('change',renderTasks);$('taskStatus').addEventListener('change',renderTasks);
 $('taskList').addEventListener('click',e=>{const b=e.target.closest('[data-task]');if(b)openTask(b.dataset.task);});
 document.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>tab(b.dataset.tab)));
 $('memberList').addEventListener('click',e=>{const b=e.target.closest('[data-approve],[data-reject]');if(b)reviewMember(b.dataset.approve||b.dataset.reject,Boolean(b.dataset.approve));});
 $('copyInvite').addEventListener('click',copyInvite);
 $('addStep').addEventListener('click',()=>appendRow('step'));$('addCheck').addEventListener('click',()=>appendRow('check'));
 $('editSteps').addEventListener('click',e=>{if(e.target.closest('.remove-row'))e.target.closest('.editable-row').remove();});
 $('editChecks').addEventListener('click',e=>{if(e.target.closest('.remove-row'))e.target.closest('.editable-row').remove();});
 $('taskForm').addEventListener('submit',submitTask);
 document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>$(b.dataset.close).close()));
 $('closeDetail').addEventListener('click',()=>$('detailDialog').close());
 $('editCurrent').addEventListener('click',()=>{const id=activeTaskId;$('detailDialog').close();editTask(id);});
 $('detailBody').addEventListener('change',e=>{if(e.target.matches('[data-check-id]'))changeCheck(e.target.dataset.checkId,e.target.checked);if(e.target.id==='detailStatus')changeStatus(e.target.value);});
 $('detailBody').addEventListener('click',e=>{if(e.target.closest('#openPhoto'))showPhotoForm();const b=e.target.closest('[data-delete-photo]');if(b)deletePhoto(b.dataset.deletePhoto);if(e.target.closest('#deleteCurrent'))deleteTask();});
 $('photoForm').addEventListener('submit',submitPhoto);$('importOld').addEventListener('change',importOld);$('exportAll').addEventListener('click',exportAll);
 document.addEventListener('visibilitychange',()=>{if(!document.hidden&&team&&user)loadTasks();});
 setInterval(()=>{if(!document.hidden&&team&&user&&navigator.onLine)loadTasks();},30000);
}
attachEvents();start();

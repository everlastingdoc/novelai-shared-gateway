import { initGallery } from './gallery.js';
const $=id=>document.getElementById(id);
const gallery=initGallery({api,getToken:()=>$('adminToken').value,notice});
let state=null,upstream=null,publicBase='',busy=false,editing=false,shares={},shareMode='equal',selectedMember=null,confirmTask=null,noticeTimer,transferEntireBalance=false;
const number=value=>value===null||value===undefined?'—':Number(value).toLocaleString('zh-CN',{maximumFractionDigits:3});
const percent=value=>number(Number(value||0)*100)+'%';
const time=value=>value?new Date(value).toLocaleString('zh-CN'):'尚未同步';
const statusNames={active:'账号可用',pending_opus:'等待接入',inactive_opus:'账号已暂停',stale:'等待同步',quota_sync_error:'同步失败',cooldown:'请求冷却中',unknown_balance:'余额未知',renewal_pending:'正在确认订阅续期'};
const memberName=u=>u.username||u.note||u.id;
function node(tag,text,cls){const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(cls)el.className=cls;return el;}
function notice(text,error=false){clearTimeout(noticeTimer);$('message').textContent=text;$('message').hidden=!text;$('message').classList.toggle('error',error);if(text&&!error)noticeTimer=setTimeout(()=>{$('message').hidden=true;},6000);}
function modal(id){$(id).showModal();}
function requireSaved(){if(editing)throw new Error('请先保存或取消份额调整。');}
async function api(path='/api/admin/member-management',body,method){
  const response=await fetch(path,{method:method||(body===undefined?'GET':'POST'),headers:{'x-admin-token':$('adminToken').value,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  let result;try{result=await response.json();}catch{throw new Error('响应异常，请检查管理隧道是否连接。');}
  if(!response.ok)throw new Error(result.message||result.error?.message||result.error||'请求失败');return result;
}
const manage=body=>api('/api/admin/member-management'+(body===undefined?'?model=single':''),body);
function updateButtons(){
  const unavailable=!state||state.migrationPending||busy;
  for(const id of ['newMember','editShares'])$(id).disabled=unavailable||editing;
  for(const id of ['saveMember','equalize','cancelShares','confirmAction','refresh','refreshUpstream','toggleUpstream','saveUpstreamPst','syncPeriod'])$(id).disabled=busy||(!!state&&['refreshUpstream','toggleUpstream','saveUpstreamPst'].includes(id)&&!upstream);
  $('saveShares').disabled=busy||!validShares();
  $('confirmTransfer').disabled=busy||!validTransfer();
  $('transferAll').disabled=busy||!(transferMaximum()>0);
  document.querySelectorAll('[data-member-manage]').forEach(el=>el.disabled=busy||editing||state?.migrationPending);
}
function run(fn){return async event=>{event?.preventDefault();if(busy)return;busy=true;updateButtons();notice('');try{await fn(event);}catch(e){notice(e.message,true);}finally{busy=false;updateButtons();}};}
function tab(id){
  document.querySelectorAll('[data-tab]').forEach(button=>button.setAttribute('aria-selected',String(button.dataset.tab===id)));
  for(const panel of ['membersPanel','settingsPanel','galleryPanel'])$(panel).hidden=panel!==id;
  if(id==='galleryPanel')gallery.show();else gallery.hide();
}
function currentTotals(){return state.users.reduce((out,u)=>{for(const field of ['v5Available','anlasFixedAvailable','anlasPurchasedAvailable'])out[field]+=u.quota?.[field]||0;return out;},{v5Available:0,anlasFixedAvailable:0,anlasPurchasedAvailable:0});}
function validShares(){const values=Object.values(shares);return !!state&&values.length===state.users.length&&values.every(value=>Number.isFinite(value)&&value>=0&&value<=1)&&Math.abs(values.reduce((n,v)=>n+v,0)-1)<=1e-6;}
function renderOverview(){
  const s=state.shared||{};
  $('overviewStatus').textContent=statusNames[s.status||state.status]||'等待核验';
  $('overviewAnlas').textContent=number(s.anlasFixed);
  $('overviewDate').textContent=s.expiresAt?'续期 '+new Date(s.expiresAt).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'订阅日期待同步';
  $('overviewPurchased').hidden=!(s.anlasPurchased>0);$('overviewPurchased').textContent='购买点数 '+number(s.anlasPurchased);
  $('overviewV5').textContent=number(s.v5Percent)+'%';$('overviewBar').value=s.v5Percent||0;
  $('overviewRecovery').textContent=s.refillSecondsPerPercent>0?'恢复 1% 约 '+number(s.refillSecondsPerPercent/60)+' 分钟':'恢复速度待官方同步';
  $('overviewQueue').textContent=(s.running||0)+' / '+(s.queued||0);
  $('overviewMembers').textContent=state.users.filter(u=>u.enabled).length+' 位启用成员 · 当前最多 '+(s.concurrencyLimit||4)+' 并发';
  $('connectedHint').textContent='已连接 · 更新于 '+new Date().toLocaleTimeString('zh-CN');
  $('allocationHint').textContent=(state.shareMode==='equal'?'大家均分':'按个人份额分配')+' · V5 和点数使用同一份额。';
  const legacy=state.subscriptionCycle?.legacyPending,renewal=state.status==='renewal_pending';
  const bad=!['active','cooldown'].includes(s.status||state.status);
  $('syncNotice').hidden=!state.migrationPending&&!legacy&&!renewal&&!bad;
  $('syncText').textContent=state.migrationPending?'还有请求在处理，完成后刷新即可调整成员额度。':legacy?'旧账本需要同步本期订阅点数。同步会保留本期消费、V5 和购买点数。':renewal?'正在确认新的订阅周期，完成后自动分配本期点数。':'账号状态需要更新，请向官方刷新额度。';
  $('syncPeriod').hidden=state.migrationPending;$('syncPeriod').textContent=legacy?'同步本期点数':'向官方刷新';
}
function shareSummary(){
  const sum=Object.values(shares).reduce((n,value)=>n+value,0);
  $('shareTotal').textContent=validShares()?'已分配 100%':'已分配 '+(Number.isFinite(sum)?number(sum*100)+'%':'—')+'，合计需要 100%';
  $('shareTotal').classList.toggle('invalid',!validShares());const amounts=currentTotals();
  for(const u of state.users){
    const share=shares[u.id],valid=Number.isFinite(share)&&share>=0&&share<=1;
    const v5=$('preview-v5-'+u.id),points=$('preview-points-'+u.id);
    if(v5)v5.textContent=valid?'保存后 '+number(amounts.v5Available*share)+'% / '+number(100*share)+'%':'请填写有效份额';
    if(points)points.textContent=valid?'保存后 '+number(amounts.anlasFixedAvailable*share)+' 点'+(amounts.anlasPurchasedAvailable>0?'；购买 '+number(amounts.anlasPurchasedAvailable*share):''):'—';
  }
  updateButtons();
}
function renderMembers(){
  const query=editing?'':$('search').value.trim().toLowerCase(),users=state.users.filter(u=>memberName(u).toLowerCase().includes(query));
  $('memberCount').textContent=users.length+' 位成员';$('members').replaceChildren();$('memberFilters').hidden=editing;$('shareActions').hidden=!editing;
  for(const u of users){
    const row=node('tr'),name=node('td');name.append(node('span',memberName(u),'member-name'));if(!u.enabled)name.append(node('span','已停用','badge'));
    const shareCell=node('td'),q=u.quota||{};
    if(editing){const input=node('input');input.type='number';input.min='0';input.max='100';input.step='any';input.className='member-share-input';input.value=Number(((shares[u.id]||0)*100).toFixed(6));input.setAttribute('aria-label',memberName(u)+' 的份额百分比');input.oninput=()=>{shares[u.id]=input.value===''?NaN:Number(input.value)/100;shareMode='custom';shareSummary();};shareCell.append(input,document.createTextNode('%'));}else shareCell.textContent=percent(q.share);
    const v5=node('td');v5.append(node('span',number(q.v5Available)+'% / '+number(q.v5Capacity)+'%','cell-value'));
    const bar=node('progress',undefined,'v5-bar');bar.max=Math.max(q.v5Capacity||0,1e-9);bar.value=q.v5Available||0;bar.setAttribute('aria-label',memberName(u)+' 的 V5 余量');v5.append(bar);
    if(q.v5Available>q.v5Capacity+1e-9)v5.append(node('span','含转入额度，暂不恢复','cell-sub'));
    const points=node('td');points.append(node('span',number(q.anlasFixedAvailable),'cell-value'));if(q.anlasPurchasedAvailable>0)points.append(node('span','购买 '+number(q.anlasPurchasedAvailable),'cell-sub'));
    if(editing){const a=node('span',undefined,'after-value'),b=node('span',undefined,'after-value');a.id='preview-v5-'+u.id;b.id='preview-points-'+u.id;v5.append(a);points.append(b);}
    const actions=node('td'),button=node('button','管理','secondary');button.dataset.memberManage=u.id;button.onclick=run(()=>openManage(u));actions.append(button);row.append(name,shareCell,v5,points,actions);$('members').append(row);
  }
  if(!users.length){const td=node('td','没有符合条件的成员','empty');td.colSpan=5;const row=node('tr');row.append(td);$('members').append(row);}
  if(editing)shareSummary();else updateButtons();
}
async function refresh(){
  state=await manage();state.users.sort((a,b)=>memberName(a).localeCompare(memberName(b)));$('autoFallback').checked=state.autoAnlasFallback===true;
  $('dashboard').hidden=false;$('connect').hidden=true;$('topActions').hidden=false;renderOverview();renderMembers();
  try{await loadUpstream();}catch(e){notice('成员信息已更新；官方账号状态暂时读取失败：'+e.message,true);}
}
async function loadUpstream(){
  const summary=await api('/api/admin/summary'),id=state.users.find(u=>u.quota?.boundAccountId)?.quota.boundAccountId,a=summary.accounts?.find(a=>a.id===id);
  publicBase=String(state.publicBaseUrl||summary.settings?.publicBaseUrl||location.origin).replace(/\/+$/,'');upstream=a?{id,enabled:a.enabled===true,tier:a.quotaTier,inFlight:Number(a.inFlight||0),fixed:a.quotaFixed,purchased:a.quotaPurchased,v5:a.v5UsagePercent,checked:a.quotaCheckedAt,error:Boolean(a.quotaError)}:null;
  if(!upstream){$('upstreamStatus').textContent='等待绑定共享 Opus';updateButtons();return;}
  $('upstreamStatus').textContent=(upstream.enabled?'已启用':'已暂停')+' · '+(upstream.tier===3?'Opus':'订阅待核验');$('upstreamQuota').textContent='V5 '+number(upstream.v5)+'% · 订阅点数 '+number(upstream.fixed)+(upstream.purchased>0?' · 购买点数 '+number(upstream.purchased):'');$('upstreamUpdated').textContent='官方查询 '+time(upstream.checked)+(upstream.error?' · 查询失败':'');$('toggleUpstream').textContent=upstream.enabled?'暂停使用':'恢复使用';updateButtons();
}
function randomPassword(){const bytes=crypto.getRandomValues(new Uint8Array(24));$('password').value=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');}
function updateCreateHint(){
  if($('editingId').value)return;const n=state.users.length+1,share=state.shareMode==='equal'?1/n:Number($('newShare').value)/100,totals=currentTotals();
  $('credentialHint').textContent=(state.shareMode==='equal'?'加入后 '+n+' 人均分当前额度。':'其他成员保持相对比例，重新分配当前额度。')+'新成员约获得 V5 '+number(totals.v5Available*share)+'%（容量 '+number(100*share)+'%），订阅点数 '+number(totals.anlasFixedAvailable*share)+(totals.anlasPurchasedAvailable>0?'，购买点数 '+number(totals.anlasPurchasedAvailable*share):'')+'。';
}
function editMember(user){
  requireSaved();$('manageDialog').close();$('editingId').value=user?.id||'';$('username').value=user?.username||'';$('username').readOnly=Boolean(user);$('password').value='';$('password').required=Boolean(user);$('password').type='password';$('showPassword').textContent='显示';$('passwordDetails').open=Boolean(user);$('passwordSummary').textContent=user?'设置新的登录密码':'自行设置密码（可选）';$('autoPasswordHint').hidden=Boolean(user);$('newShareLabel').hidden=Boolean(user)||state.shareMode==='equal';$('newShare').required=!user&&state.shareMode==='custom';$('newShare').value=Number((100/(state.users.length+1)).toFixed(6));$('memberDialogTitle').textContent=user?'重置密码 · '+memberName(user):'新增成员';$('saveMember').textContent=user?'保存新密码':'创建并分配额度';
  if(user)$('credentialHint').textContent='原个人 Key 和余额保留；旧登录会话将失效。';else updateCreateHint();modal('memberDialog');
}
async function delivery(user,password){
  const key=await manage({action:'member-key',userId:user.id}),portal=String(state.publicBaseUrl||publicBase||location.origin).replace(/\/+$/,'');$('deliveryText').value=['成员入口：'+portal+'/','用户名：'+user.username,'密码：'+(password||'使用原密码，忘记请联系管理员重置'),'API Base：'+portal+'/v1','API Key：'+key.apiKey].join('\n');modal('deliveryDialog');
}
function openManage(user){
  selectedMember=user;const q=user.quota||{};$('manageName').textContent=memberName(user);$('manageQuota').textContent='份额 '+percent(q.share)+' · V5 '+number(q.v5Available)+'% / '+number(q.v5Capacity)+'% · 订阅点数 '+number(q.anlasFixedAvailable);$('managePurchased').hidden=!(q.anlasPurchasedAvailable>0);$('managePurchased').textContent='购买点数 '+number(q.anlasPurchasedAvailable);$('toggleMember').textContent=user.enabled?'停用成员':'恢复成员';$('resetPassword').disabled=!user.enabled;$('removeMember').disabled=state.users.length<=1;$('transferMember').disabled=state.users.length<=1;modal('manageDialog');
}
const transferNames={v5:'V5 余量',anlasFixed:'订阅点数',anlasPurchased:'购买点数'};
function transferParties(){return {from:state?.users.find(u=>u.id===$('transferFrom').value),to:state?.users.find(u=>u.id===$('transferTo').value),resource:$('transferResource').value,amount:transferEntireBalance?transferMaximum():Number($('transferAmount').value)};}
function transferMaximum(){const from=state?.users.find(u=>u.id===$('transferFrom').value),resource=$('transferResource').value,balance=from?.quota?.[resource+'Available']||0;return resource==='v5'?balance:Math.floor(balance);}
function validTransfer(){const {from,to,resource,amount}=transferParties();return Boolean(from&&to&&from.id!==to.id&&Number.isFinite(amount)&&amount>0&&amount<=transferMaximum()&&(resource==='v5'||Number.isInteger(amount)));}
function transferHint(){
  const {from,to,resource,amount}=transferParties(),v5=resource==='v5',maximum=transferMaximum(),unit=v5?'%':' 点',value=Number.isFinite(amount)&&amount>=0?amount:0;
  const source=from?.quota?.[resource+'Available']||0,target=to?.quota?.[resource+'Available']||0;
  $('transferAmountLabel').textContent=v5?'转移数量（V5 百分点）':'转移数量（整数点数）';$('transferAmount').min=v5?'0.000001':'1';$('transferAmount').step=v5?'any':'1';$('transferAmount').max=String(maximum);
  $('transferHint').textContent=from&&to?memberName(from)+'：'+number(source)+unit+' → '+number(source-value)+unit+'；'+memberName(to)+'：'+number(target)+unit+' → '+number(target+value)+unit+'。'+(v5?'双方 V5 容量不变。'+(target+value>(to.quota?.v5Capacity||0)+1e-9?'接收方超过容量期间暂停恢复，用到低于容量后继续恢复。':''):''):'';
  $('transferError').hidden=true;updateButtons();
}
function openTransfer(){
  requireSaved();const user=selectedMember;if(!user)return;const recipients=state.users.filter(u=>u.id!==user.id&&u.quota?.member);if(!recipients.length)throw new Error('至少需要两位成员才能转移额度。');
  $('manageDialog').close();$('transferFrom').value=user.id;$('transferFromName').textContent=memberName(user);$('transferTo').replaceChildren(...recipients.map(u=>{const option=node('option',memberName(u)+(u.enabled?'':'（已停用）'));option.value=u.id;return option;}));
  transferEntireBalance=false;$('transferResource').value='v5';$('transferResource').querySelector('option[value="anlasPurchased"]').hidden=!state.users.some(u=>u.quota?.anlasPurchasedAvailable>0);$('transferAmount').value='';transferHint();modal('transferDialog');
}
function confirmation(title,description,task){$('confirmTitle').textContent=title;$('confirmDescription').textContent=description;confirmTask=task;modal('confirmDialog');}
async function refreshOfficial(){if(!upstream)throw new Error('尚未绑定官方账号');const result=await api('/api/admin/accounts/quota',{ids:[upstream.id]});if(result.failed)throw new Error('官方查询失败，请检查账号凭据。');}
$('connect').onsubmit=run(async()=>{await refresh();if($('remember').checked)sessionStorage.setItem('nai.adminSession',$('adminToken').value);else sessionStorage.removeItem('nai.adminSession');});
$('disconnect').onclick=()=>{gallery.reset();tab('membersPanel');sessionStorage.removeItem('nai.adminSession');localStorage.removeItem('nai.adminToken');$('adminToken').value='';$('deliveryText').value='';$('password').value='';$('upstreamPst').value='';document.querySelectorAll('dialog[open]').forEach(d=>d.close());state=null;upstream=null;editing=false;shares={};selectedMember=null;$('dashboard').hidden=true;$('topActions').hidden=true;$('connect').hidden=false;notice('已退出管理。');};
for(const button of document.querySelectorAll('[data-tab]'))button.onclick=()=>tab(button.dataset.tab);
for(const button of document.querySelectorAll('[data-close]'))button.onclick=()=>$(button.dataset.close).close();
$('refresh').onclick=run(async()=>{requireSaved();await refresh();notice('状态已刷新。');});$('search').oninput=()=>{if(state)renderMembers();};
$('editShares').onclick=run(()=>{editing=true;shareMode=state.shareMode;shares=Object.fromEntries(state.users.map(u=>[u.id,u.quota?.share||0]));renderMembers();});
$('equalize').onclick=()=>{if(busy)return;shareMode='equal';shares=Object.fromEntries(state.users.map(u=>[u.id,1/state.users.length]));renderMembers();};
$('cancelShares').onclick=run(async()=>{editing=false;shares={};await refresh();});
$('saveShares').onclick=run(async()=>{if(!validShares())throw new Error('请把成员份额合计调整为 100%。');await manage({action:'allocation',shareMode,shares,expectedConfigVersion:state.configVersion});editing=false;shares={};try{await refresh();notice('V5 和点数已按新份额分配。');}catch{renderMembers();notice('分配已保存，页面刷新失败；请刷新查看，勿重复提交。',true);}});
$('newMember').onclick=run(()=>editMember());$('generatePassword').onclick=randomPassword;$('showPassword').onclick=()=>{const show=$('password').type==='password';$('password').type=show?'text':'password';$('showPassword').textContent=show?'隐藏':'显示';};$('newShare').oninput=updateCreateHint;
$('credentials').onsubmit=run(async()=>{
  const id=$('editingId').value,password=$('password').value;
  const created=await manage(id?{action:'credentials',userId:id,username:$('username').value,password}:{action:'create-member',username:$('username').value,...(password?{password}:{}),newMemberShare:Number($('newShare').value)/100,expectedConfigVersion:state.configVersion});$('memberDialog').close();let failed=false;try{await refresh();}catch{failed=true;}
  notice((id?'密码已更新，原个人 Key 保留。':'成员已创建，V5 和点数已分配。')+(failed?' 页面刷新失败，请稍后刷新。':''),failed);
  try{await delivery({id:created.id,username:created.username},created.password||password);}catch{notice('账户已保存，分发信息读取失败。请从成员管理重新打开；未保存的密码可重置。',true);}
});
$('memberDialog').addEventListener('close',()=>{$('password').value='';});$('deliveryDialog').addEventListener('close',()=>{$('deliveryText').value='';});
$('transferMember').onclick=run(openTransfer);
for(const id of ['transferTo','transferResource'])$(id).onchange=()=>{if(id==='transferResource'){transferEntireBalance=false;$('transferAmount').value='';}transferHint();};
$('transferAmount').oninput=()=>{transferEntireBalance=false;transferHint();};
$('transferAll').onclick=()=>{if(busy)return;transferEntireBalance=true;$('transferAmount').value=String(Math.floor(transferMaximum()*1e6)/1e6);transferHint();};
$('transferForm').onsubmit=async event=>{
  event.preventDefault();if(busy)return;busy=true;updateButtons();$('transferError').hidden=true;
  try{
    if(!validTransfer())throw new Error('请填写有效数量，不能超过转出成员的当前余额。');
    const {from,to,resource,amount}=transferParties();await manage({action:'transfer-quota',fromUserId:from.id,toUserId:to.id,resource,amount,allAvailable:transferEntireBalance,expectedConfigVersion:state.configVersion});$('transferDialog').close();selectedMember=null;
    try{await refresh();notice(transferNames[resource]+' 已转移，份额与 V5 容量保持不变。');}catch{notice('转移已完成，请刷新查看最新余额，勿重复提交。',true);}
  }catch(e){$('transferError').textContent=e.message.includes('预留额度的任务')?'还有请求在处理，完成后即可转移。':e.message;$('transferError').hidden=false;}
  finally{busy=false;updateButtons();}
};
$('copyDelivery').onclick=run(async()=>{await navigator.clipboard.writeText($('deliveryText').value);notice('已复制该成员的登录信息和个人 Key。');});$('deliverMember').onclick=run(async()=>{if(selectedMember){$('manageDialog').close();await delivery(selectedMember);}});$('resetPassword').onclick=run(()=>{if(selectedMember)editMember(selectedMember);});
$('toggleMember').onclick=run(()=>{const user=selectedMember;if(!user)return;$('manageDialog').close();confirmation((user.enabled?'停用 ':'恢复 ')+memberName(user),user.enabled?'暂停登录和新的生图请求。原个人 Key、份额和余额保留。':'恢复原个人 Key 和登录，继续使用保留的余额。',async()=>{await manage({action:'member-status',userId:user.id,enabled:!user.enabled});$('confirmDialog').close();await refresh();notice('成员状态已更新。');});});
$('removeMember').onclick=run(()=>{const user=selectedMember;if(!user)return;const q=user.quota||{};$('manageDialog').close();confirmation('删除 '+memberName(user)+'？','登录和个人 Key 会立即失效，历史记录保留。剩余 V5 '+number(q.v5Available)+'% 和订阅点数 '+number(q.anlasFixedAvailable)+(q.anlasPurchasedAvailable>0?'、购买点数 '+number(q.anlasPurchasedAvailable):'')+' 将按其余成员的份额分配。',async()=>{await manage({action:'remove-member',userId:user.id,expectedConfigVersion:state.configVersion});$('confirmDialog').close();selectedMember=null;try{await refresh();notice('成员已删除，剩余额度已分配给其他成员。');}catch{notice('成员已删除，请刷新查看最新名单。',true);}});});
$('confirmAction').onclick=run(async()=>{if(confirmTask)await confirmTask();});$('confirmDialog').addEventListener('close',()=>{confirmTask=null;});
$('saveFallback').onclick=run(async()=>{await manage({action:'fallback-policy',enabled:$('autoFallback').checked});state.autoAnlasFallback=$('autoFallback').checked;notice('设置已保存，之后的请求生效。');});
$('refreshUpstream').onclick=run(async()=>{requireSaved();await refreshOfficial();await refresh();notice('已向官方刷新额度。');});
$('syncPeriod').onclick=run(async()=>{requireSaved();await refreshOfficial();await refreshOfficial();await refresh();if(state.subscriptionCycle?.legacyPending){await manage({action:'sync-period',expectedConfigVersion:state.configVersion});await refresh();}notice(state.status==='renewal_pending'?'还有请求在处理，完成后再次刷新即可。':'本期额度已同步。');});
$('toggleUpstream').onclick=run(async()=>{requireSaved();if(!upstream)throw new Error('尚未绑定官方账号');const enabled=!upstream.enabled;if(enabled)await refreshOfficial();await api('/api/admin/accounts/'+encodeURIComponent(upstream.id),{enabled},'PATCH');await refresh();notice(enabled?'账号已恢复使用。':'账号已暂停使用。');});
$('upstreamCredentials').onsubmit=run(async()=>{requireSaved();if(!upstream)throw new Error('尚未绑定官方账号');if(upstream.inFlight)throw new Error('请等待正在生成的请求完成。');const token=$('upstreamPst').value.trim();if(!/^pst-[A-Za-z0-9_-]+$/.test(token))throw new Error('请输入完整 PST');await api('/api/admin/accounts/'+encodeURIComponent(upstream.id),{token},'PATCH');$('upstreamPst').value='';await refreshOfficial();await refresh();notice('PST 已更新，账号保持暂停；核验额度后再恢复使用。');});
window.addEventListener('beforeunload',event=>{if(editing){event.preventDefault();event.returnValue='';}});
$('adminToken').value=sessionStorage.getItem('nai.adminSession')||localStorage.getItem('nai.adminToken')||'';
if($('adminToken').value){busy=true;refresh().catch(()=>notice('请重新登录管理端。',true)).finally(()=>{busy=false;updateButtons();});}
setInterval(async()=>{if(!state||busy||editing||document.querySelector('dialog[open]')||document.activeElement?.matches('input,select,textarea'))return;busy=true;try{await refresh();}catch{}finally{busy=false;updateButtons();}},30000);

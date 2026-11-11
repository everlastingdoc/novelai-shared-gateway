import { assertFairQuotaIdle, syncFairQuota } from './fair-quota.js';

const fields=['v5Available','anlasFixedAvailable','anlasPurchasedAvailable'];
const empty=()=>({v5Available:0,anlasFixedAvailable:0,anlasPurchasedAvailable:0,anlasAvailable:0});
const fail=(message,statusCode=400)=>{throw Object.assign(new Error(message),{statusCode});};
const total=(s,field)=>Object.values(s.balances).reduce((n,b)=>n+b[field],0);
const audit=(s,entry)=>{s.configurationHistory=[...(s.configurationHistory||[]),entry].slice(-1000);};
const totals=s=>{for(const b of Object.values(s.balances))b.anlasAvailable=b.anlasFixedAvailable+b.anlasPurchasedAvailable;};
export const equalShares=ids=>Object.fromEntries(ids.map(id=>[id,1/ids.length]));

// 尾差归最后一个正份额成员，零份额不接收余额；不以显示精度改写账本。
export function splitQuota(amount,shares) {
  const ids=Object.keys(shares),positive=ids.filter(id=>shares[id]>0),last=positive.at(-1);
  let remaining=amount;
  return Object.fromEntries(ids.map(id=>{const value=id===last?remaining:shares[id]>0?amount*shares[id]:0;remaining-=value;return [id,Math.max(0,value)];}));
}

export function migrateSinglePool(db, now=Date.now()) {
  if(db.settings?.fairQuota?.allocationModel==='single_pool')return db.settings.fairQuota;
  assertFairQuotaIdle(db);
  let s=syncFairQuota(db,now);
  if(!s?.enabled) {
    const ids=db.users.map(u=>u.id);
    if(!ids.length)fail('请先创建一位成员',409);
    s=db.settings.fairQuota={enabled:true,members:ids,boundAccountId:null,balances:Object.fromEntries(ids.map(id=>[id,empty()])),reservations:{},snapshot:null,spent:{v5:0,anlas:0,anlasFixed:0,anlasPurchased:0},creditedV5:0,lastRefillAt:0,lastSettlementAt:0,status:'pending_opus',configVersion:0,configurationHistory:[]};
    s.shares=equalShares(ids);
  } else {
    const groups=s.groups||[];
    s.shares=Object.fromEntries(s.members.map(id=>{const g=groups.find(g=>g.members.includes(id)),weights=g?.members.reduce((n,key)=>n+(g.memberWeights?.[key]??1),0);return [id,g&&weights>0?g.share*(g.memberWeights?.[id]??1)/weights:0];}));
    // 已有账号全纳入同一名单；历史上未分配的账号保留零余额，等待管理员调整。
    for(const u of db.users)if(!s.members.includes(u.id)){s.members.push(u.id);s.shares[u.id]=0;s.balances[u.id]=empty();}
    s.legacyGroups=structuredClone(groups);delete s.groups;
  }
  s.allocationModel='single_pool';s.version=3;
  s.shareMode=s.members.every(id=>Math.abs(s.shares[id]-1/s.members.length)<1e-8)?'equal':'custom';
  s.configVersion+=1;
  audit(s,{at:now,action:'migrate-single-pool',version:s.configVersion,shares:structuredClone(s.shares),balances:structuredClone(s.balances)});
  return syncFairQuota(db,now);
}

function normalizeShares(ids,shares) {
  if(!shares||typeof shares!=='object'||Array.isArray(shares)||Object.keys(shares).length!==ids.length||ids.some(id=>!Object.hasOwn(shares,id)))fail('请为每位成员填写份额');
  if(Object.values(shares).some(v=>typeof v!=='number'||!Number.isFinite(v)||v<0||v>1))fail('份额必须介于 0% 和 100%');
  const sum=Object.values(shares).reduce((n,v)=>n+v,0);
  if(Math.abs(sum-1)>1e-6)fail('成员份额合计须为 100%');
  return Object.fromEntries(ids.map(id=>[id,shares[id]/sum]));
}

function redistribute(s,shares,now,action) {
  const beforeBalances=structuredClone(s.balances),beforeShares=structuredClone(s.shares);
  const amounts=Object.fromEntries(fields.map(field=>[field,total(s,field)]));
  if(amounts.v5Available>100+1e-7)fail('V5 余额异常，请先核对现有账本',409);
  s.members=Object.keys(shares);s.shares=shares;
  s.balances=Object.fromEntries(s.members.map(id=>[id,empty()]));
  for(const field of fields)for(const [id,value] of Object.entries(splitQuota(amounts[field],shares)))s.balances[id][field]=value;
  totals(s);s.configVersion+=1;
  audit(s,{at:now,action,actorId:'administrator',version:s.configVersion,beforeShares,shares:structuredClone(shares),beforeBalances,afterBalances:structuredClone(s.balances)});
}

export function configureSinglePool(db,body,now=Date.now()) {
  assertFairQuotaIdle(db);
  const draft={...db,settings:structuredClone(db.settings)};
  const s=migrateSinglePool(draft,now);
  syncFairQuota(draft,now);
  if(!Number.isInteger(body.expectedConfigVersion)||body.expectedConfigVersion!==s.configVersion)fail('成员信息已更新，请刷新页面后再调整',409);
  if(!['equal','custom'].includes(body.shareMode))fail('分配方式无效');
  const shares=body.shareMode==='equal'?equalShares(s.members):normalizeShares(s.members,body.shares);
  redistribute(s,shares,now,'allocate-single-pool');s.shareMode=body.shareMode;
  db.settings=draft.settings;return s;
}

// 与创建密码、用户及 Key 的同一存储事务调用；调用者也在副本上工作。
export function joinSinglePool(db,userId,body,now=Date.now()) {
  assertFairQuotaIdle(db);
  const s=migrateSinglePool(db,now);
  syncFairQuota(db,now);
  if(body.expectedConfigVersion!==s.configVersion)fail('成员信息已更新，请刷新后重新创建',409);
  if(s.members.includes(userId))fail('成员已存在');
  if(s.members.length>=100)fail('共享成员总数不能超过 100',409);
  const ids=[...s.members,userId];
  let shares=equalShares(ids);
  if(s.shareMode==='custom') {
    const value=body.newMemberShare;
    if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>1)fail('请填写新成员份额（0%–100%）');
    shares=Object.fromEntries([...s.members.map(id=>[id,s.shares[id]*(1-value)]),[userId,value]]);
  }
  redistribute(s,shares,now,'create-member');return s;
}

export function removeSinglePoolMember(db,body,now=Date.now()) {
  assertFairQuotaIdle(db);
  const draft={...db,users:structuredClone(db.users),settings:structuredClone(db.settings)};
  const s=migrateSinglePool(draft,now);syncFairQuota(draft,now);
  if(body.expectedConfigVersion!==s.configVersion)fail('成员信息已更新，请刷新后重试',409);
  if(!s.members.includes(body.userId)||!draft.users.some(u=>u.id===body.userId))fail('成员不存在',404);
  if(s.members.length<=1)fail('请至少保留一位成员',409);
  const id=body.userId,ids=s.members.filter(key=>key!==id),beforeShares=structuredClone(s.shares),beforeBalances=structuredClone(s.balances);
  const remaining=ids.reduce((n,key)=>n+s.shares[key],0);
  const shares=s.shareMode==='equal'||remaining<=0?equalShares(ids):Object.fromEntries(ids.map(key=>[key,s.shares[key]/remaining]));
  for(const field of fields)for(const [key,value] of Object.entries(splitQuota(s.balances[id][field],shares)))s.balances[key][field]+=value;
  delete s.balances[id];s.members=ids;s.shares=shares;totals(s);s.configVersion+=1;
  audit(s,{at:now,action:'remove-member',actorId:'administrator',userId:id,version:s.configVersion,beforeShares,shares:structuredClone(shares),beforeBalances,afterBalances:structuredClone(s.balances)});
  draft.users=draft.users.filter(u=>u.id!==id);db.settings=draft.settings;db.users=draft.users;
  return {deletedUserId:id,configVersion:s.configVersion};
}

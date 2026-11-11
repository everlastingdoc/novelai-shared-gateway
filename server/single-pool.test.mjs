import test from 'node:test';
import assert from 'node:assert/strict';
import {configureFairQuota,configureFairGroups,syncFairQuota,fairQuotaSummary,reserveFairQuota,settleFairQuota,initializeSubscriptionCycle,manageFairMember} from './fair-quota.js';
import {migrateSinglePool,configureSinglePool,joinSinglePool,removeSinglePoolMember,splitQuota} from './single-pool.js';
const NOW=1800000000000,DAY=86400000;
const request={model:'nai-diffusion-5-full',width:1024,height:1024,steps:23};
const sum=(db,field)=>Object.values(db.settings.fairQuota.balances).reduce((n,b)=>n+b[field],0);
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);
function fixture(percent=60){
  const db={users:['a','b','c','d'].map(id=>({id,token:'NAI-'+id,enabled:true})),settings:{},jobs:[],accounts:[{id:'opus',enabled:true,subscriptionActive:true,subscriptionExpiresAt:NOW+DAY,quotaTier:3,quotaFixed:10000,quotaPurchased:1000,v5UsagePercent:percent,v5UsageTimeUntilNextPercent:0,quotaCheckedAt:NOW}]};
  configureFairQuota(db,db.users.map(u=>u.id));syncFairQuota(db,NOW);return db;
}
function incoming(db,at,changes={}){Object.assign(db.accounts[0],changes,{quotaCheckedAt:at});return syncFairQuota(db,at);}
function allocate(db,shareMode='equal',shares,now=NOW){return configureSinglePool(db,{shareMode,shares,expectedConfigVersion:db.settings.fairQuota.configVersion},now);}
function transfer(db,resource,amount,changes={},now=NOW){return manageFairMember(db,{action:'transfer-quota',fromUserId:'a',toUserId:'b',resource,amount,expectedConfigVersion:db.settings.fairQuota.configVersion,...changes},now);}
test('单车 V5 转入可超过容量，份额、容量、周期和其他钱包不变，重启与失败退款不裁剪',()=>{
  let db=fixture();migrateSinglePool(db,NOW);const before=structuredClone(db),original=structuredClone(db.settings.fairQuota);
  transfer(db,'v5',15);let s=db.settings.fairQuota;
  assert.deepEqual(s.shares,original.shares);assert.equal(s.shareMode,original.shareMode);assert.deepEqual(s.subscriptionCycle,original.subscriptionCycle);assert.deepEqual(db.users,before.users);
  close(s.balances.a.v5Available,0);close(s.balances.b.v5Available,30);close(sum(db,'v5Available'),60);
  for(const id of ['c','d'])assert.deepEqual(s.balances[id],original.balances[id]);
  close(sum(db,'anlasFixedAvailable'),10000);close(sum(db,'anlasPurchasedAvailable'),1000);
  let q=fairQuotaSummary(db,db.users[1],NOW);close(q.v5Capacity,25);close(q.v5Available,30);close(q.share,.25);close(q.v5RefillPerDay,0);
  assert.equal(s.configurationHistory.at(-1).transferred.v5,15);assert.deepEqual(s.configurationHistory.at(-1).shares,original.shares);
  db=structuredClone(db);incoming(db,NOW+1);s=db.settings.fairQuota;close(s.balances.b.v5Available,30);
  const job={id:'transferred-quota-job',request};reserveFairQuota(db,db.users[1],job,db.accounts[0],NOW+1);assert.ok(s.balances.b.v5Available<30);settleFairQuota(db,job,false,NOW+2);settleFairQuota(db,job,false,NOW+3);close(s.balances.b.v5Available,30);
});
test('超容量转入不参与恢复，真实生图消耗到容量以下后按原份额恢复',()=>{
  const db=fixture(80);migrateSinglePool(db,NOW);transfer(db,'v5',10);incoming(db,NOW+1,{v5UsageTimeUntilNextPercent:600});syncFairQuota(db,NOW+300001);
  close(db.settings.fairQuota.balances.b.v5Available,30);close(sum(db,'v5Available'),80.5);
  let consumed=0,count=0;
  while(db.settings.fairQuota.balances.b.v5Available>=25){const job={id:'use-transferred-'+count++,request};const charge=reserveFairQuota(db,db.users[1],job,db.accounts[0],NOW+300001);assert.equal(charge.resource,'v5');settleFairQuota(db,job,true,NOW+300001);consumed+=charge.amount;assert.ok(count<1000);}
  const b=db.settings.fairQuota.balances.b.v5Available,all=sum(db,'v5Available');incoming(db,NOW+300002,{v5UsagePercent:80.5-consumed});syncFairQuota(db,NOW+360002);
  assert.ok(db.settings.fairQuota.balances.b.v5Available>b);assert.ok(db.settings.fairQuota.balances.b.v5Available<=25+1e-9);close(sum(db,'v5Available'),all+.1);close(fairQuotaSummary(db,db.users[1],NOW+360002).v5Capacity,25);
});
test('订阅和购买点数只在指定钱包转移，非法请求/余额不足/活动任务/过时版本原子拒绝',()=>{
  const db=fixture();migrateSinglePool(db,NOW);db.users[0].enabled=false;
  const shares=structuredClone(db.settings.fairQuota.shares);transfer(db,'anlasFixed',123);transfer(db,'anlasPurchased',17);
  close(db.settings.fairQuota.balances.a.anlasFixedAvailable,2377);close(db.settings.fairQuota.balances.b.anlasFixedAvailable,2623);close(db.settings.fairQuota.balances.a.anlasPurchasedAvailable,233);close(db.settings.fairQuota.balances.b.anlasPurchasedAvailable,267);close(sum(db,'anlasFixedAvailable'),10000);close(sum(db,'anlasPurchasedAvailable'),1000);assert.deepEqual(db.settings.fairQuota.shares,shares);
  let before=structuredClone(db);
  for(const change of [{amount:2378},{toUserId:'a'},{toUserId:'missing'},{resource:'anlasFixed',amount:.5},{resource:'invalid'},{amount:NaN},{amount:0},{expectedConfigVersion:0},{resource:'v5',amount:16}]){assert.throws(()=>transfer(db,'anlasFixed',1,change));assert.deepEqual(db,before);}
  db.jobs.push({id:'busy',status:'queued'});before=structuredClone(db);assert.throws(()=>transfer(db,'v5',1));assert.deepEqual(db,before);db.jobs[0].status='done';db.settings.fairQuota.reservations.pending={status:'reserved',resource:'free',amount:0,userId:'a'};before=structuredClone(db);assert.throws(()=>transfer(db,'v5',1));assert.deepEqual(db,before);
});
test('零份额成员可使用管理员转入的 V5，但不会获得容量或恢复份额',()=>{
  const db=fixture();migrateSinglePool(db,NOW);allocate(db,'custom',{a:1,b:0,c:0,d:0});transfer(db,'v5',10);
  const q=fairQuotaSummary(db,db.users[1],NOW);close(q.v5Available,10);close(q.v5Capacity,0);close(q.v5RefillPerDay,0);close(q.share,0);const job={id:'zero-share-use',request};assert.equal(reserveFairQuota(db,db.users[1],job,db.accounts[0],NOW).resource,'v5');settleFairQuota(db,job,false,NOW+1);close(db.settings.fairQuota.balances.b.v5Available,10);
});
test('全部转出以保存时的最新余额为准，不留下显示精度尾差，点数保留不足整点部分',()=>{
  const db=fixture();migrateSinglePool(db,NOW);incoming(db,NOW+1,{v5UsageTimeUntilNextPercent:600});
  const before=sum(db,'v5Available'),version=db.settings.fairQuota.configVersion;
  const result=transfer(db,'v5',0,{allAvailable:true,expectedConfigVersion:version},NOW+300001);
  close(db.settings.fairQuota.balances.a.v5Available,0);assert.ok(result.transferred.v5>15);close(sum(db,'v5Available'),before+.5);
  db.settings.fairQuota.balances.a.anlasFixedAvailable=12.75;const points=transfer(db,'anlasFixed',0,{allAvailable:true},NOW+300001);close(points.transferred.anlasFixed,12);close(db.settings.fairQuota.balances.a.anlasFixedAvailable,.75);
  const saved=structuredClone(db);assert.throws(()=>transfer(db,'v5',1,{allAvailable:'true'},NOW+300001));assert.deepEqual(db,saved);
});
test('旧多组迁移保留所有钱包、V5 容量、凭据和历史，不维护两套份额',()=>{
  const db=fixture();configureFairGroups(db,db.users.map((u,i)=>({id:'g'+i,members:[u.id],share:[.4,.3,.2,.1][i]})),{now:NOW});
  const before=structuredClone(db),caps=db.users.map(u=>fairQuotaSummary(db,u,NOW).v5Capacity);
  migrateSinglePool(db,NOW);const s=db.settings.fairQuota;
  assert.equal(s.allocationModel,'single_pool');assert.equal(s.shareMode,'custom');assert.equal(s.groups,undefined);assert.equal(s.legacyGroups.length,4);
  assert.deepEqual(s.balances,before.settings.fairQuota.balances);assert.deepEqual(db.users,before.users);assert.deepEqual(s.reservations,before.settings.fairQuota.reservations);
  assert.deepEqual(db.users.map(u=>fairQuotaSummary(db,u,NOW).v5Capacity),caps);
  const snapshot=structuredClone(s);migrateSinglePool(db,NOW);assert.deepEqual(s,snapshot);
  assert.throws(()=>configureFairGroups(db,before.settings.fairQuota.groups,{now:NOW}),/成员与额度/);
});
test('均分、个人份额同时控制 V5 余额、容量、恢复和两类点数，全池守恒',()=>{
  const db=fixture();migrateSinglePool(db,NOW);const totals=['v5Available','anlasFixedAvailable','anlasPurchasedAvailable'].map(f=>sum(db,f));
  allocate(db,'custom',{a:.7,b:.1,c:.2,d:0});
  for(const [i,f] of ['v5Available','anlasFixedAvailable','anlasPurchasedAvailable'].entries())close(sum(db,f),totals[i]);
  const q=fairQuotaSummary(db,db.users[0],NOW);close(q.v5Capacity,70);close(q.v5Available,42);close(q.anlasFixedAvailable,7000);close(q.anlasPurchasedAvailable,700);
  incoming(db,NOW+1,{v5UsageTimeUntilNextPercent:600});syncFairQuota(db,NOW+300001);
  close(db.settings.fairQuota.balances.a.v5Available,42.35);close(db.settings.fairQuota.balances.d.v5Available,0);
});
test('默认新增即可使用额度：六人均分的 V5 和点数精确守恒',()=>{
  const db=fixture();migrateSinglePool(db,NOW);
  for(const id of ['e','f']){db.users.push({id,enabled:true,token:'NAI-'+id});joinSinglePool(db,id,{expectedConfigVersion:db.settings.fairQuota.configVersion},NOW);}
  close(sum(db,'v5Available'),60);close(sum(db,'anlasFixedAvailable'),10000);close(sum(db,'anlasPurchasedAvailable'),1000);
  const q=fairQuotaSummary(db,db.users.at(-1),NOW);assert.equal(q.member,true);close(q.v5Available,10);close(q.v5Capacity,100/6);close(q.anlasFixedAvailable,10000/6);
  const job={id:'new-member-job',request};assert.equal(reserveFairQuota(db,db.users.at(-1),job,db.accounts[0],NOW).resource,'v5');
});
test('自定义模式新增保留其他成员相对比例，删除分回余额，停用成员份额保留',()=>{
  const db=fixture();migrateSinglePool(db,NOW);allocate(db,'custom',{a:.4,b:.3,c:.2,d:.1});db.users.push({id:'e',enabled:true});
  joinSinglePool(db,'e',{newMemberShare:.2,expectedConfigVersion:db.settings.fairQuota.configVersion},NOW);
  close(db.settings.fairQuota.shares.a,.32);close(db.settings.fairQuota.shares.b,.24);close(db.settings.fairQuota.shares.e,.2);
  db.users[1].enabled=false;const before=structuredClone(db.settings.fairQuota.balances);removeSinglePoolMember(db,{userId:'e',expectedConfigVersion:db.settings.fairQuota.configVersion},NOW);
  close(db.settings.fairQuota.shares.a,.4);close(sum(db,'v5Available'),60);close(sum(db,'anlasFixedAvailable'),10000);assert.equal(db.users[1].enabled,false);assert.ok(db.settings.fairQuota.balances.b.v5Available>before.b.v5Available);
});
test('并发任务、非法份额及过时页面均原子拒绝，删除保留历史预留和任务',()=>{
  const db=fixture();migrateSinglePool(db,NOW);let before=structuredClone(db);
  assert.throws(()=>allocate(db,'custom',{a:1,b:1,c:0,d:0}));assert.deepEqual(db,before);
  assert.throws(()=>configureSinglePool(db,{shareMode:'equal',expectedConfigVersion:0},NOW),/刷新/);assert.deepEqual(db,before);
  const job={id:'busy',status:'queued',userToken:'NAI-a',request};db.jobs.push(job);before=structuredClone(db);
  assert.throws(()=>allocate(db),/任务/);assert.throws(()=>removeSinglePoolMember(db,{userId:'a',expectedConfigVersion:db.settings.fairQuota.configVersion},NOW),/任务/);assert.deepEqual(db,before);
  job.status='done';db.settings.fairQuota.reservations.old={status:'settled',userId:'a',resource:'v5',amount:.1};const history=structuredClone(db.settings.fairQuota.reservations);
  removeSinglePoolMember(db,{userId:'a',expectedConfigVersion:db.settings.fairQuota.configVersion},NOW);assert.deepEqual(db.settings.fairQuota.reservations,history);assert.deepEqual(db.jobs,[job]);
});
test('分配尾差和零份额不增发或丢失余额',()=>{
  for(let n=2;n<=100;n++){const shares=Object.fromEntries(Array.from({length:n},(_,i)=>['m'+i,i===0?0:1/(n-1)]));for(const value of [0,.000001,61.2351,10000,8318.3]){const split=splitQuota(value,shares);close(Object.values(split).reduce((a,b)=>a+b,0),value);assert.equal(split.m0,0);assert.ok(Object.values(split).every(v=>v>=0));}}
});
test('订阅续期：官方仍10000、本地8318，连续两次独立快照后只补正一次',()=>{
  let db=fixture();migrateSinglePool(db,NOW);let s=db.settings.fairQuota;
  for(const b of Object.values(s.balances))b.anlasFixedAvailable=2079.5;
  s.fallbackBuffer.fixed=1682;
  const v5=sum(db,'v5Available'),purchased=sum(db,'anlasPurchasedAvailable'),expiry=db.accounts[0].subscriptionExpiresAt;
  let at=expiry+1000;incoming(db,at,{subscriptionExpiresAt:expiry+30*DAY});assert.equal(s.status,'renewal_pending');close(sum(db,'anlasFixedAvailable'),8318);
  syncFairQuota(db,at+1);close(sum(db,'anlasFixedAvailable'),8318);
  incoming(db,at+2000);close(sum(db,'anlasFixedAvailable'),10000);close(sum(db,'v5Available'),v5);close(sum(db,'anlasPurchasedAvailable'),purchased);assert.equal(s.fallbackBuffer.fixed,0);assert.equal(s.subscriptionCycleHistory.length,1);
  db=structuredClone(db);s=db.settings.fairQuota;incoming(db,at+3000);incoming(db,at+4000);close(sum(db,'anlasFixedAvailable'),10000);assert.equal(s.subscriptionCycleHistory.length,1);
});
test('同周期续用不因刷新/重启退款；提前延长日期和小幅更正不视作新一期',()=>{
  const db=fixture();migrateSinglePool(db,NOW);const s=db.settings.fairQuota;s.autoAnlasFallback=true;s.balances.a.v5Available=0;
  const job={id:'fallback',request};const charge=reserveFairQuota(db,db.users[0],job,db.accounts[0],NOW);settleFairQuota(db,job,true,NOW+1);
  const expected=10000-charge.fixed;incoming(db,NOW+2);close(sum(db,'anlasFixedAvailable'),expected);
  incoming(db,NOW+3,{subscriptionExpiresAt:NOW+31*DAY});close(sum(db,'anlasFixedAvailable'),expected);assert.equal(s.subscriptionCycleHistory,undefined);
  incoming(db,NOW+4,{subscriptionExpiresAt:NOW+DAY+10000});close(sum(db,'anlasFixedAvailable'),expected);
});
test('跨期任务结清并取得新快照后才切期，失败退款不会增加新期/V5/购买钱包',()=>{
  const db=fixture();migrateSinglePool(db,NOW);const expiry=db.accounts[0].subscriptionExpiresAt;
  const paid={id:'crossing',request:{...request,width:1536}};reserveFairQuota(db,db.users[0],paid,db.accounts[0],NOW);
  incoming(db,expiry+1000,{subscriptionExpiresAt:expiry+30*DAY});incoming(db,expiry+2000);assert.equal(db.settings.fairQuota.subscriptionCycleHistory,undefined);
  assert.throws(()=>reserveFairQuota(db,db.users[1],{id:'blocked',request},db.accounts[0],expiry+2000),/renewal_pending/);
  settleFairQuota(db,paid,false,expiry+3000);syncFairQuota(db,expiry+3000);assert.equal(db.settings.fairQuota.subscriptionCycleHistory,undefined);
  incoming(db,expiry+4000);close(sum(db,'anlasFixedAvailable'),10000);const before=structuredClone(db.settings.fairQuota.balances);
  settleFairQuota(db,paid,false,expiry+5000);assert.deepEqual(db.settings.fairQuota.balances,before);
});
test('旧账本首次补正保留本期续用，只移除旧期buffer，幂等且不重置V5',()=>{
  const db=fixture();migrateSinglePool(db,NOW);const s=db.settings.fairQuota;delete s.subscriptionCycle;s.autoAnlasFallback=true;
  s.fallbackBuffer.fixed=1682;for(const b of Object.values(s.balances))b.anlasFixedAvailable-=420.5;
  s.reservations.old={accountId:'opus',userId:'a',status:'settled',billingMode:'anlas_fallback',fixed:1682,settledAt:NOW-31*DAY};
  incoming(db,NOW+1);assert.equal(s.subscriptionCycle.legacyPending,true);const before=structuredClone(db);
  assert.throws(()=>initializeSubscriptionCycle(db,s.configVersion,NOW+1),/刷新/);assert.deepEqual(db,before);
  s.balances.a.v5Available=0;const job={id:'this-period',request};reserveFairQuota(db,db.users[0],job,db.accounts[0],NOW+1);settleFairQuota(db,job,true,NOW+2);
  incoming(db,NOW+3);const v5=sum(db,'v5Available'),purchased=sum(db,'anlasPurchasedAvailable');
  initializeSubscriptionCycle(db,s.configVersion,NOW+3);close(sum(db,'anlasFixedAvailable'),10000-job.fairCharge.fixed);close(sum(db,'v5Available'),v5);close(sum(db,'anlasPurchasedAvailable'),purchased);assert.equal(db.settings.fairQuota.fallbackBuffer.fixed,job.fairCharge.fixed);
  const saved=structuredClone(db);assert.deepEqual(initializeSubscriptionCycle(db,0,NOW+3),{alreadySynced:true});assert.deepEqual(db,saved);
});
test('已使用真实点数的新期只分官方实际剩余余额，查询失败/旧快照不能发点',()=>{
  const db=fixture(),s=db.settings.fairQuota,expiry=db.accounts[0].subscriptionExpiresAt;
  incoming(db,expiry+1000,{subscriptionExpiresAt:expiry+30*DAY,quotaFixed:9700,quotaError:'temporarily failed'});close(sum(db,'anlasFixedAvailable'),10000);
  incoming(db,expiry+2000,{quotaError:''});assert.equal(s.status,'renewal_pending');incoming(db,expiry+3000);close(sum(db,'anlasFixedAvailable'),9700);
});

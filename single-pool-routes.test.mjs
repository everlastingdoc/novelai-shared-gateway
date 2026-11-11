import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {handleMemberRoutes} from './server/member-routes.js';
import {configureFairQuota,syncFairQuota} from './server/fair-quota.js';
import {setMemberCredentials} from './server/member-auth.js';
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);

test('单车管理员流程：创建即分配V5和点数、原子失败、份额保存、成员权限与删除撤销',async t=>{
  const now=Date.now(),db={settings:{},jobs:[],users:['a','b','c','d'].map(id=>({id,token:'NAI-'+id,enabled:true})),accounts:[{id:'opus',token:'pst-SYNTHETIC-NEVER-UPSTREAM',enabled:true,quotaTier:3,subscriptionActive:true,subscriptionExpiresAt:now+86400000,quotaFixed:10000,quotaPurchased:0,v5UsagePercent:60,v5UsageTimeUntilNextPercent:0,quotaCheckedAt:now}]};
  configureFairQuota(db,db.users.map(u=>u.id));syncFairQuota(db);await setMemberCredentials(db,'a',{username:'member-a',password:'synthetic-test-password-a'});
  let queue=Promise.resolve(),ids=0;
  const deps={store:{update(fn){queue=queue.catch(()=>{}).then(()=>fn(db));return queue;}},assertAdmin(req){if(req.headers['x-admin-token']!=='synthetic-admin')throw Object.assign(new Error('admin required'),{statusCode:403});},createId:()=> 'new-'+(++ids),createPublicToken:()=> 'NAI-synthetic-'+ids};
  const server=http.createServer(async(req,res)=>{try{if(!await handleMemberRoutes(req,res,new URL(req.url,'http://localhost'),deps)){res.writeHead(404);res.end();}}catch(e){res.writeHead(e.statusCode||500,{'content-type':'application/json'});res.end(JSON.stringify({error:e.message}));}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});const base='http://127.0.0.1:'+server.address().port;
  async function call(path,body,headers={}){const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Origin:base,'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,headers:r.headers,data:await r.json()};}
  const admin=body=>call('/api/admin/member-management',body,{'x-admin-token':'synthetic-admin'});
  let result=await call('/api/member/login',{username:'member-a',password:'synthetic-test-password-a'});const cookie=result.headers.get('set-cookie').split(';')[0];
  for(const action of ['allocation','create-member','remove-member','sync-period']){
    const before=structuredClone(db);result=await call('/api/admin/member-management',{action,username:'bad-member'},{cookie,authorization:'Bearer NAI-a'});assert.equal(result.status,403);assert.deepEqual(db,before);
  }
  result=await call('/api/admin/member-management?model=single',undefined,{'x-admin-token':'synthetic-admin'});assert.equal(result.status,200);assert.equal(result.data.allocationModel,'single_pool');assert.equal(result.data.shareMode,'equal');
  assert.ok(!JSON.stringify(result.data).includes('pst-SYNTHETIC'));assert.ok(!JSON.stringify(result.data).includes('NAI-a'));assert.ok(!JSON.stringify(result.data).includes('memberAuth'));
  const version=result.data.configVersion,originalUsers=structuredClone(db.users);let before=structuredClone(db);
  result=await admin({action:'create-member',username:'member-e',password:'short',expectedConfigVersion:version});assert.equal(result.status,400);assert.deepEqual(db,before);
  result=await admin({action:'create-member',username:'member-e',expectedConfigVersion:version-1});assert.equal(result.status,409);assert.deepEqual(db,before);
  db.jobs.push({id:'queued',status:'queued'});before=structuredClone(db);result=await admin({action:'create-member',username:'member-e',expectedConfigVersion:version});assert.equal(result.status,409);assert.deepEqual(db,before);db.jobs[0].status='failed';
  result=await admin({action:'create-member',username:'member-e',expectedConfigVersion:version});assert.equal(result.status,200);const created=result.data;assert.ok(created.password.length>=12);const e=db.users.find(u=>u.id===created.id);
  assert.equal(db.settings.fairQuota.balances[e.id].v5Available,12);assert.equal(db.settings.fairQuota.balances[e.id].anlasFixedAvailable,2000);assert.deepEqual(db.users.slice(0,4),originalUsers);
  result=await call('/api/member/login',{username:'member-e',password:created.password});assert.equal(result.status,200);const eCookie=result.headers.get('set-cookie').split(';')[0];result=await call('/api/member/me',undefined,{cookie:eCookie});assert.equal(result.data.quota.member,true);assert.equal(result.data.quota.v5Capacity,20);
  const shares=Object.fromEntries(db.users.map((u,i)=>[u.id,i===0?.6:.1]));result=await admin({action:'allocation',shareMode:'custom',shares,expectedConfigVersion:db.settings.fairQuota.configVersion});assert.equal(result.status,200);close(db.settings.fairQuota.balances.a.v5Available,36);close(db.settings.fairQuota.balances.a.anlasFixedAvailable,6000);
  before=structuredClone(db);result=await admin({action:'credentials',username:'unjoined',password:'synthetic-unjoined-password'});assert.equal(result.status,409);assert.deepEqual(db,before);
  result=await admin({action:'create-member',username:'member-f',newMemberShare:.2,expectedConfigVersion:db.settings.fairQuota.configVersion});assert.equal(result.status,200);close(db.settings.fairQuota.shares.a,.48);close(db.settings.fairQuota.balances[result.data.id].v5Available,12);
  result=await admin({action:'remove-member',userId:e.id,expectedConfigVersion:db.settings.fairQuota.configVersion});assert.equal(result.status,200);assert.ok(!db.users.some(u=>u.id===e.id));result=await call('/api/member/me',undefined,{cookie:eCookie});assert.equal(result.status,401);result=await call('/api/member/login',{username:'member-e',password:created.password});assert.equal(result.status,401);
  const total=field=>Object.values(db.settings.fairQuota.balances).reduce((n,b)=>n+b[field],0);assert.ok(Math.abs(total('v5Available')-60)<1e-8);assert.ok(Math.abs(total('anlasFixedAvailable')-10000)<1e-8);
  result=await call('/api/member/me',undefined,{cookie});assert.equal(result.status,200);assert.ok(!JSON.stringify(result.data).includes('pst-SYNTHETIC'));assert.ok(!JSON.stringify(result.data).includes('member-e'));
});

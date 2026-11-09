import test from 'node:test';
import assert from 'node:assert/strict';
import { accountIdentity, compareIdentity, contextKey, hydrateRefreshState, debounceDelay, writebackBudgetRemaining,
  stageCapture, rollbackCapture, evaluateLiveCookies, resolveClassification, captureStamp, syncFlushScript } from '../src/refresh.js';
const c = (name, value, site = 'github.com', extra = {}) => ({ name, value, domain: `.${site}`, path: '/', secure: true, session: false, expirationDate: 4_000_000_000, ...extra });
const github = (who = 'alice', session = 'A') => [c('dotcom_user', who), c('user_session', session)];

test('strict rules recognize each supported site and require the primary auth cookie', () => {
  for (const [site, id, value, auth] of [['github.com','dotcom_user','Alice','user_session'], ['bilibili.com','DedeUserID','123','SESSDATA'], ['x.com','twid','u%3D123','auth_token'], ['twitter.com','twid','u=456','auth_token']]) {
    const cookies = [c(id,value,site), c(auth,'token',site)];
    assert.equal(accountIdentity(site,cookies).status, 'verified');
    assert.equal(accountIdentity(site,cookies.slice(0,1)).status, 'logged-out');
    assert.equal(accountIdentity(site,cookies.slice(1)).status, 'unknown');
    assert.equal(accountIdentity(site,[...cookies,c(id,value,site)]).status, 'unknown');
  }
  assert.equal(accountIdentity('bilibili.com',[c('DedeUserID','1','bilibili.com'),c('bili_jct','csrf','bilibili.com')]).status, 'logged-out');
});
test('subdomain, partition, insecure, empty and invalid identity cookies cannot authorize refresh', () => {
  for (const change of [{domain:'.evil.github.com'}, {path:'/other'}, {secure:false}, {partitionKey:{topLevelSite:'https://github.com'}}, {value:''}, {value:'not a login'}]) {
    assert.equal(accountIdentity('github.com',[{...github()[0],...change},github()[1]]).status,'unknown');
  }
  assert.equal(accountIdentity('x.com',[c('twid','bad%escape','x.com'),c('auth_token','t','x.com')]).status,'unknown');
});
test('same account rotation writes, changed identity and logout pause', () => {
  const before=github(); const live=github('alice','A2');
  const classification=resolveClassification({siteKey:'github.com',baseline:before,live});
  assert.equal(evaluateLiveCookies({classification,baseline:before,live}).action,'write');
  assert.equal(evaluateLiveCookies({classification,baseline:before,live:github('bob','B')}).action,'unbind');
  assert.equal(compareIdentity('github.com',before,[before[0]]).status,'logged-out');
  assert.equal(compareIdentity('github.com',before,[before[0],c('user_session','x','github.com',{expirationDate:1})]).status,'logged-out');
});
test('only expiry sliding and analytics changes leave the previous version alone', () => {
  const before=github(); const live=github(); live[1].expirationDate += 100;
  const classification=resolveClassification({siteKey:'github.com',baseline:before,live});
  assert.equal(evaluateLiveCookies({classification,baseline:before,live}).action,'refresh-cookies');
  assert.equal(evaluateLiveCookies({classification,baseline:before,live:[...live,c('_ga','stats')]}).action,'refresh-cookies');
  assert.equal(evaluateLiveCookies({classification:{siteKey:'unknown.test'},baseline:before,live}).write,false);
});
test('legacy learned rules never grant identity verification; recovery pauses survive hydration', () => {
  const old={bindings:{'github.com':{site:'github.com',snapshotId:'a',storeId:'0',learned:{identity:['lang'],auth:['sid']}}}};
  const key=contextKey('github.com','0');
  assert.equal(hydrateRefreshState(old).bindings[key].manualOnly,true);
  const state={version:2,bindings:{[key]:{site:'github.com',storeId:'0',snapshotId:'a',paused:true,status:'recovered',generation:'one'}}};
  assert.equal(hydrateRefreshState(state).bindings[key].paused,true);
  state.bindings[key].locked=true;
  assert.equal(hydrateRefreshState(state).bindings[key].status,'interrupted');
  assert.notEqual(contextKey('github.com','0'),contextKey('github.com','1'));
});
test('debounce is trailing 1.5s, capped at 3s, with a 5s write budget', () => {
  assert.equal(debounceDelay(0,0),1500); assert.equal(debounceDelay(0,2500),500);
  assert.equal(debounceDelay(0,3500),0); assert.equal(writebackBudgetRemaining(100,5100),0);
});
test('previous captures are bounded and exact; serialization ignores object insertion order', () => {
  const a={cookies:github(),localStorage:{a:'1',b:'2'},sessionStorage:{tab:'A'}};
  const b={...a,cookies:github('alice','A2')};
  const staged=stageCapture(stageCapture(a,b),b);
  assert.equal(staged.prev.prev,undefined); assert.deepEqual(rollbackCapture(staged).capture.cookies,b.cookies);
  assert.equal(captureStamp(a),captureStamp({...a,localStorage:{b:'2',a:'1'},cookies:[...a.cookies].reverse()}));
});
test('dynamic observer registration changes only when bound origins change', async () => {
  let scripts=[];let writes=0;
  const scripting={getRegisteredContentScripts:async()=>scripts, unregisterContentScripts:async()=>{scripts=[];writes++;},registerContentScripts:async s=>{scripts=s;writes++;}};
  const b={origin:'https://github.com',owner:{tabId:1},accountKey:'alice'};
  await syncFlushScript(scripting,{one:b}); assert.equal(writes,1);
  await syncFlushScript(scripting,{one:b}); assert.equal(writes,1);
  await syncFlushScript(scripting,{one:{...b,paused:true}}); assert.equal(scripts.length,0);
});

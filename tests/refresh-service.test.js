import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, cookie } from './helpers/refresh-harness.js';
import { RefreshService } from '../src/refresh-service.js';
import { removeProfileCapture } from '../src/profiles.js';

test('save creates a fixed backup; multiple token rotations cannot replace it', async t=>{
  const h=harness();t.after(()=>h.service.dispose());await h.save();const backup=structuredClone(h.backup());
  h.cookies[1].value='A2';await h.write();h.cookies[1].value='A3';await h.write();
  assert.equal(h.capture().cookies[1].value,'A3');assert.deepEqual(h.backup(),backup);
  assert.equal(h.capture().prev.cookies[1].value,'A2');
  h.cookies[0].value='bob';h.cookies[1].value='B';await h.write();
  assert.equal(h.capture().cookies[1].value,'A3');assert.equal(h.service.binding(h.key()).paused,true);
  const view=await h.service.inspect(h.tab());assert.equal(view.currentProfileId,null);assert.equal(view.canUpdate,false);
});
test('unknown manual confirmation is one-shot, content-bound, and never enables auto refresh', async t=>{
  const h=harness('shop.test');t.after(()=>h.service.dispose());await h.save();const backup=structuredClone(h.backup());
  h.cookies[0].value='A2';const first=await h.service.update(h.tab(),h.id);assert.equal(first.needsConfirm,true);
  h.cookies[0].value='B1';const changed=await h.service.update(h.tab(),h.id,first.confirm.token);assert.equal(changed.needsConfirm,true);
  assert.equal(h.capture().cookies[0].value,'A1');
  const written=await h.service.update(h.tab(),h.id,changed.confirm.token);assert.equal(written.effect.type,'updated');
  assert.equal(written.view.autoRefreshEnabled,false);assert.equal(written.view.currentProfileId,null);
  h.cookies[0].value='B2';await h.write();assert.equal(h.capture().cookies[0].value,'B1');assert.deepEqual(h.backup(),backup);
  assert.equal((await h.service.update(h.tab(),h.id,changed.confirm.token)).needsConfirm,true);
});
test('same-name save and known cross-account manual update are rejected', async t=>{
  const h=harness();t.after(()=>h.service.dispose());await h.save();const old=structuredClone(h.capture());
  await assert.rejects(h.service.save(h.tab(),'A'),/名字另存/);
  h.cookies[0].value='bob';h.cookies[1].value='B';await assert.rejects(h.service.update(h.tab(),h.id),/账号与快照不符/);
  assert.deepEqual(h.capture(),old);
});
test('restoring backup changes only the snapshot and the durable pause survives restart', async t=>{
  const h=harness();t.after(()=>h.service.dispose());await h.save();h.cookies[1].value='A2';await h.write();
  const oldGeneration=h.service.binding(h.key()).generation;const live=structuredClone([h.cookies,h.localStorage,h.sessionStorage]);
  await h.service.backupAction(h.tab(),h.id,'restore-protected-backup');
  assert.equal(h.capture().cookies[1].value,'A1');assert.deepEqual([h.cookies,h.localStorage,h.sessionStorage],live);
  assert.equal(h.capture().prev.cookies[1].value,'A2');
  assert.equal(await h.service.autoWrite(h.key(),oldGeneration,h.time),false);
  h.service.dispose();h.service=new RefreshService(h.deps);await h.service.start();assert.equal(h.service.binding(h.key()).paused,true);
  assert.equal(await h.write(),false);assert.equal(h.capture().cookies[1].value,'A1');
});
test('replacing protected backup requires confirmation of the exact saved version', async t=>{
  const h=harness();t.after(()=>h.service.dispose());await h.save();const first=await h.service.backupAction(h.tab(),h.id,'set-protected-backup');
  h.cookies[1].value='A2';await h.write();const changed=await h.service.backupAction(h.tab(),h.id,'set-protected-backup',first.confirm.token);
  assert.equal(changed.needsConfirm,true);assert.equal(h.backup().capture.cookies[1].value,'A1');
  await h.service.backupAction(h.tab(),h.id,'set-protected-backup',changed.confirm.token);
  assert.equal(h.backup().capture.cookies[1].value,'A2');assert.equal(h.backup().source,'user-confirmed');
});
test('legacy migration protects prev before any new write and preserves expiry-only history', async t=>{
  const h=harness();t.after(()=>h.service.dispose());await h.save();h.cookies[1].value='A2';await h.write();
  delete h.data[`protectedBackup:${h.id}`];h.cookies[1].value='A3';await h.write();
  assert.equal(h.backup().source,'migration-prev');assert.equal(h.backup().capture.cookies[1].value,'A1');
  const previous=structuredClone(h.capture().prev);h.cookies[1].expirationDate+=500;await h.write();assert.deepEqual(h.capture().prev,previous);
});
test('storage observer rejects stale documents, stores, generations and sibling origins', async t=>{
  const h=harness();t.after(()=>h.service.dispose());await h.save();const b=h.service.binding(h.key());
  const message={type:'flush-storage',generation:b.generation,origin:h.origin,localStorage:{token:'next'},sessionStorage:{tab:'next'}};
  for(const changes of [{documentId:'old'},{frameId:1},{origin:'https://evil.github.com'},{tab:{id:9}},{id:'foreign'}]){
    await h.service.observer(message,{...h.sender(),...changes});assert.equal(h.capture().localStorage.token,'A-storage');
  }
  await h.service.observer({...message,generation:'old'},h.sender());assert.equal(h.capture().localStorage.token,'A-storage');
  h.storeId='1';await h.service.observer(message,h.sender());assert.equal(h.capture().localStorage.token,'A-storage');h.storeId='0';
  await h.service.observer(message,h.sender());assert.equal(h.capture().localStorage.token,'next');
  assert.equal(h.capture().prev.localStorage.token,'A-storage');assert.equal(h.backup().capture.localStorage.token,'A-storage');
});
test('pagehide rechecks identity before merging any storage', async t=>{
  const h=harness();t.after(()=>h.service.dispose());await h.save();const b=h.service.binding(h.key());
  h.cookies[0].value='bob';h.cookies[1].value='B';
  await h.service.observer({type:'flush-storage',generation:b.generation,origin:h.origin,localStorage:{token:'B'},sessionStorage:{}},h.sender());
  assert.equal(h.capture().localStorage.token,'A-storage');assert.equal(h.service.binding(h.key()).paused,true);
});
test('save immediately injects the current document; only source-tab navigation can renew it', async t=>{
  const h=harness();t.after(()=>h.service.dispose());await h.save();assert.equal(h.injections,1);
  h.documentId='doc-2';await h.service.attach(h.key(),false);assert.equal(h.injections,1);
  await h.service.attach(h.key(),true);assert.equal(h.injections,2);assert.equal(h.service.binding(h.key()).owner.documentId,'doc-2');
});
test('failed commit preserves current, previous and backup; changed revisions cancel writes', async t=>{
  const h=harness();t.after(()=>h.service.dispose());await h.save();const prior=structuredClone(h.data);h.cookies[1].value='A2';
  h.failSet=true;await assert.rejects(h.write(),/disk unavailable/);assert.deepEqual(h.data,prior);h.failSet=false;
  await h.service.update(h.tab(),h.id);h.cookies[1].value='A3';const old=structuredClone(h.capture());
  const collect=h.service.collectCookies;h.service.collectCookies=async(...a)=>{const r=await collect(...a);h.service.revisions.set(h.key(),h.service.rev(h.key())+1);return r;};
  await assert.rejects(h.write(),/登录态已变化/);assert.deepEqual(h.capture(),old);
});
test('switch lock drops events and stale generations; background restart keeps interrupted pause', async t=>{
  const h=harness();t.after(()=>h.service.dispose());await h.save();const oldGeneration=h.service.binding(h.key()).generation;
  await h.service.beforeSwitch(h.tab(),h.site);h.cookies[1].value='B';
  for(const fn of h.events.cookie)fn({cookie:{...h.cookies[1],storeId:'0'}});await h.settle();
  assert.equal(h.service.timers.size,0);assert.equal(await h.service.autoWrite(h.key(),oldGeneration),false);
  h.service.dispose();h.service=new RefreshService(h.deps);await h.service.start();assert.equal(h.service.binding(h.key()).status,'interrupted');
});
test('confirmations expire and are invalid after worker restart', async t=>{
  const h=harness('shop.test');t.after(()=>h.service.dispose());await h.save();h.cookies[0].value='A2';
  const q=await h.service.update(h.tab(),h.id);h.time+=60001;assert.equal((await h.service.update(h.tab(),h.id,q.confirm.token)).needsConfirm,true);
  h.service.dispose();h.service=new RefreshService(h.deps);await h.service.start();assert.equal((await h.service.update(h.tab(),h.id,q.confirm.token)).needsConfirm,true);
});
test('permanent delete removes the protected backup as well as the capture', async t=>{
  const h=harness();t.after(()=>h.service.dispose());await h.save();await removeProfileCapture(h.id);assert.equal(h.capture(),undefined);assert.equal(h.backup(),undefined);
});

test('storage-only unknown sites can be saved and explicitly confirmed without claiming a current account', async t=>{
  const h=harness('storage.test');h.cookies=[];t.after(()=>h.service.dispose());const result=await h.save();
  assert.equal(result.view.loggedIn,true);assert.equal(result.view.currentProfileId,null);
  assert.equal(result.view.canConfirmUpdate,true);assert.equal(result.view.autoRefreshEnabled,false);
});
test('missing authentication pauses without overwriting any stored version', async t=>{
  const h=harness();t.after(()=>h.service.dispose());await h.save();const before=structuredClone([h.capture(),h.backup()]);
  h.cookies=h.cookies.filter(c=>c.name!=='user_session');await h.write();
  assert.equal(h.service.binding(h.key()).status,'logged-out');assert.deepEqual([h.capture(),h.backup()],before);
});
test('failed storage reads and oversized captures never replace saved data with an empty or partial capture', async t=>{
  const h=harness();t.after(()=>h.service.dispose());await h.save();const before=structuredClone(h.data);
  const read=h.service.readCapture;h.service.readCapture=async()=>{throw new Error('storage unavailable');};
  await assert.rejects(h.service.update(h.tab(),h.id),/storage unavailable/);assert.deepEqual(h.data,before);
  h.service.readCapture=read;h.localStorage.blob='x'.repeat(8_000_001);
  await assert.rejects(h.service.update(h.tab(),h.id),/8MB/);assert.deepEqual(h.data,before);
});
test('the write budget is rechecked after asynchronous backup reads and before committing', async t=>{
  const h=harness();t.after(()=>h.service.dispose());await h.save();const before=structuredClone(h.data);h.cookies[1].value='A2';
  const get=h.api.storage.local.get;
  h.api.storage.local.get=async key=>{const value=await get(key);if(key===`protectedBackup:${h.id}`)h.time+=6000;return value;};
  await assert.rejects(h.write(),/超时/);assert.deepEqual(h.data,before);
});
test('switching an unverified migrated backup with a conflicting known account cannot enable auto writes', async t=>{
  const h=harness();t.after(()=>h.service.dispose());await h.save();const profile=h.data.profiles[0];
  h.cookies[0].value='bob';h.data[`capture:${h.id}`].cookies=structuredClone(h.cookies);
  await h.service.beforeSwitch(h.tab(),h.site);await h.service.afterSwitch(h.tab(),profile);
  assert.equal(h.service.binding(h.key()).paused,true);assert.equal(h.service.binding(h.key()).status,'different');
});
test('explicitly rebinding a snapshot in another cookie store revokes its previous source', async t=>{
  const h=harness();t.after(()=>h.service.dispose());await h.save();const oldKey=h.key();const oldGeneration=h.service.binding(oldKey).generation;
  h.storeId='1';await h.service.update(h.tab(),h.id);
  assert.equal(h.service.binding(h.key()).paused,false);assert.equal(h.service.binding(oldKey).paused,true);
  assert.equal(h.service.binding(oldKey).owner,null);
  h.cookies[1].value='another-session';assert.equal(await h.service.autoWrite(oldKey,oldGeneration),false);
  assert.equal(h.capture().cookies[1].value,'A1');
});

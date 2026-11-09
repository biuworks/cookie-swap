import { RefreshService } from '../../src/refresh-service.js';
import { toSnapshot } from '../../src/cookies.js';
import { contextKey } from '../../src/refresh.js';
export const cookie = (name,value,site='github.com',extra={}) => ({name,value,domain:`.${site}`,path:'/',secure:true,httpOnly:true,sameSite:'lax',session:false,expirationDate:4_000_000_000,...extra});
export function harness(site='github.com') {
  const h={data:{},time:1_800_000_000_000,site,storeId:'0',documentId:'doc-1',tabId:1,origin:`https://${site}`,failSet:false,injections:0,events:{}};
  h.cookies=site==='github.com'?[cookie('dotcom_user','alice'),cookie('user_session','A1')]:[cookie('sid','A1',site),cookie('lang','zh',site)];
  h.localStorage={token:'A-storage'}; h.sessionStorage={tab:'A-tab'};
  const event=name=>({addListener:fn=>{(h.events[name]||=[]).push(fn);},removeListener:()=>{}});
  const api={runtime:{id:'test-extension',onStartup:event('startup')},cookies:{onChanged:event('cookie')},
    tabs:{get:async id=>({id,url:h.origin+'/page',status:'complete'}),onUpdated:event('updated'),onRemoved:event('removed')},
    scripting:{executeScript:async options=>{
      if(options.files){h.injections++;return [{documentId:h.documentId}];}
      return [{documentId:h.documentId,result:options.func.name==='readPageStorage'?{origin:h.origin,localStorage:structuredClone(h.localStorage),sessionStorage:structuredClone(h.sessionStorage)}:h.origin}];
    },getRegisteredContentScripts:async()=>h.scripts||[],registerContentScripts:async v=>{h.scripts=v;},unregisterContentScripts:async()=>{h.scripts=[];}},
    storage:{local:{get:async keys=>{
      if(keys==null)return structuredClone(h.data);
      return Object.fromEntries((Array.isArray(keys)?keys:[keys]).filter(k=>k in h.data).map(k=>[k,structuredClone(h.data[k])]));
    },set:async values=>{if(h.failSet)throw new Error('disk unavailable');Object.assign(h.data,structuredClone(values));},remove:async keys=>{for(const k of Array.isArray(keys)?keys:[keys])delete h.data[k];}}}};
  globalThis.chrome=api;h.api=api;
  let chain=Promise.resolve(); const enqueue=fn=>{const p=chain.then(fn,fn);chain=p.catch(()=>{});return p;};
  h.queue=enqueue;h.settle=()=>chain;h.key=()=>contextKey(site,h.storeId);
  h.tab=()=>({id:h.tabId,url:h.origin+'/page'});
  h.sender=()=>({id:api.runtime.id,frameId:0,tab:{id:h.tabId},documentId:h.documentId,origin:h.origin,url:h.origin+'/page'});
  h.deps={api,enqueue,getStoreId:async()=>h.storeId,collectCookies:async()=>structuredClone(h.cookies),now:()=>h.time,readCapture:async()=>({siteKey:site,origin:h.origin,hostLabel:site,documentId:h.documentId,storeId:h.storeId,cookies:h.cookies.map(toSnapshot),localStorage:structuredClone(h.localStorage),sessionStorage:structuredClone(h.sessionStorage)})};
  h.service=new RefreshService(h.deps);
  h.save=async()=>{await h.service.start();const r=await h.service.save(h.tab(),'A');h.id=r.view.profiles[0].id;return r;};
  h.capture=()=>h.data[`capture:${h.id}`]; h.backup=()=>h.data[`protectedBackup:${h.id}`];
  h.write=()=>h.service.autoWrite(h.key(),h.service.binding(h.key()).generation,h.time);
  return h;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

// 外部通信や実GPSを使わず、画面のイベントとlocalStorageへの保存を検証。
class Element {
  constructor(attrs={}) {this.attrs=attrs;this.dataset={};for(const[k,v]of Object.entries(attrs))if(k.startsWith('data-'))this.dataset[k.slice(5)]=v;this.listeners={};this.value=attrs.value||'';this.hidden='hidden'in attrs;this.checked='checked'in attrs;this.disabled='disabled'in attrs;this.textContent='';this.classList={add(){},remove(){}};}
  addEventListener(k,f){(this.listeners[k]??=[]).push(f);}
  async fire(k,extra={}) {const e={preventDefault(){},target:this,button:0,...extra};for(const f of this.listeners[k]||[])await f(e);await new Promise(r=>setImmediate(r));}
  setAttribute(k,v){this.attrs[k]=v;if(k==='hidden')this.hidden=true;}
  removeAttribute(k){delete this.attrs[k];}
  focus(){}
  set innerHTML(value){this.html=value;this.elements=[];let m;const tags=/<([a-z][a-z0-9-]*)\b([^>]*)>/gi;while((m=tags.exec(value))){const attrs={};let a;const re=/([\w-]+)(?:="([^"]*)")?/g;while((a=re.exec(m[2])))attrs[a[1]]=a[2]??'';const el=new Element(attrs);if(m[1]==='textarea')el.value=value.slice(tags.lastIndex,value.indexOf('</textarea>',tags.lastIndex));this.elements.push(el);}}
  get innerHTML(){return this.html||'';}
  querySelector(s){return this.querySelectorAll(s)[0]??null;}
  querySelectorAll(s){if(s.startsWith('#'))return(this.elements||[]).filter(e=>e.attrs.id===s.slice(1));const m=/^\[([^\]]+)\]$/.exec(s);return m?(this.elements||[]).filter(e=>m[1]in e.attrs):[];}
}
const fixture={interpretation:'見本',places:[{id:'osm:node/1',name:'場所1',kind:'公園',lat:35.01,lon:135.76,hint:'緑',place_id:null,maps_uri:null},{id:'osm:node/2',name:'場所2',kind:'公園',lat:35.02,lon:135.77,hint:'緑',place_id:null,maps_uri:null}],polyline:'sample',total_minutes:45,attributions:[],sources:[],blocked:null};
const clarification={question:'どんな気分？',options:[{label:'緑の中へ',crowd:'neutral'}],blocked:null};
let seq=0;
async function setup({freshPosition=true,geoFailure=false,quotaFailure=false}={}) {
  const app=new Element(),brand=new Element(),badge=new Element(),memory=new Map([['yorimichi:notice','true']]);let watchCallback,stopped=0,confirmValue=true;
  globalThis.document={querySelector:s=>s==='#app'?app:s==='.brand'?brand:badge,createElement:()=>({}),head:{append:s=>queueMicrotask(()=>s.onerror?.())}};
  globalThis.location={search:'?mock=1'};globalThis.window={isSecureContext:true,addEventListener(){}};
  globalThis.localStorage={getItem:k=>memory.get(k)??null,setItem:(k,v)=>{if(quotaFailure&&k==='yorimichi:walks')throw Error('quota');memory.set(k,v);},removeItem:k=>memory.delete(k)};
  globalThis.confirm=()=>confirmValue;
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{geolocation:{watchPosition:f=>{watchCallback=f;return 1;},clearWatch:()=>stopped++,getCurrentPosition:(ok,fail)=>geoFailure?fail({code:1}):ok({coords:{latitude:35.1,longitude:135.8}})}}});
  globalThis.FormData=class{get(){return '60'}};
  globalThis.fetch=async url=>({ok:true,status:200,json:async()=>structuredClone(url.includes('clarify')?clarification:fixture)});
  await import(pathToFileURL(new URL('../app.js',import.meta.url).pathname).href+'?test='+seq++);
  const click=async id=>{const el=app.querySelector('#'+id);assert.ok(el,'missing #'+id);await el.fire('click');};
  const submit=async id=>await app.querySelector('#'+id).fire('submit');
  async function walk() {app.querySelector('#mood').value='懐かしい';await submit('mood-form');await app.querySelectorAll('[data-option]')[0].fire('click');await submit('setup-form');app.querySelector('#save-track').checked=true;await click('start');if(freshPosition)watchCallback({coords:{latitude:35.008,longitude:135.748,accuracy:10},timestamp:Date.now()});}
  return{app,brand,memory,click,submit,walk,setConfirm:v=>confirmValue=v,stopped:()=>stopped,sendPosition:(lat,lon)=>watchCallback({coords:{latitude:lat,longitude:lon,accuracy:10},timestamp:Date.now()})};
}

test('途中終了のキャンセルは画面・位置追跡・記録を維持',async()=>{const t=await setup();await t.walk();t.setConfirm(false);await t.click('stop');assert.ok(t.app.querySelector('#arrive'));assert.equal(t.stopped(),0);assert.equal(t.memory.has('yorimichi:walks'),false);assert.equal(JSON.parse(t.memory.get('yorimichi:tracks:v1'))[0].status,'active');});
test('未訪問でも記録して停止し、現在地から新しい気分・時間で開始',async()=>{const t=await setup();await t.walk();await t.click('stop');assert.ok(t.app.querySelector('#restart-walk'));assert.equal(t.stopped(),1);const old=JSON.parse(t.memory.get('yorimichi:walks'))[0];assert.equal(old.status,'stopped');assert.equal(old.places.length,0);assert.ok(old.ended_at);assert.ok(old.elapsed_seconds>=0);assert.equal(JSON.parse(t.memory.get('yorimichi:tracks:v1'))[0].status,'stopped');await t.click('restart-walk');assert.equal(t.app.querySelector('#mood').value,'');t.app.querySelector('#mood').value='新しい気分';await t.submit('mood-form');await t.app.querySelectorAll('[data-option]')[0].fire('click');assert.equal(t.app.querySelector('#lat').value,'35.008');assert.equal(t.app.querySelector('#lon').value,'135.748');assert.match(t.app.innerHTML,/value="45" checked/);await t.submit('setup-form');assert.equal(t.app.querySelector('#save-track').checked,false);await t.click('start');await t.click('stop');const all=JSON.parse(t.memory.get('yorimichi:walks'));assert.equal(all.length,2);assert.notEqual(all[0].id,all[1].id);});
test('ロゴからの終了確認と、mock指定の維持',async()=>{const t=await setup();assert.equal(t.brand.attrs.href,'./?mock=1');await t.walk();t.setConfirm(false);await t.brand.fire('click');assert.ok(t.app.querySelector('#arrive'));t.setConfirm(true);await t.brand.fire('click');assert.ok(t.app.querySelector('#finish-today'));await t.click('finish-today');assert.match(t.app.innerHTML,/おつかれさまでした/);assert.equal(t.memory.has('yorimichi:walks'),true);});
test('現在地がまだない場合は再取得し、新しい出発地の初期値へ',async()=>{const t=await setup({freshPosition:false});await t.walk();await t.click('stop');await t.click('restart-walk');t.app.querySelector('#mood').value='緑';await t.submit('mood-form');await t.app.querySelectorAll('[data-option]')[0].fire('click');assert.equal(t.app.querySelector('#lat').value,'35.1');assert.equal(t.app.querySelector('#lon').value,'135.8');});
test('再取得できなくても入力に戻り、出発地の確認を案内する',async()=>{const t=await setup({freshPosition:false,geoFailure:true});await t.walk();await t.click('stop');await t.click('restart-walk');assert.ok(t.app.querySelector('#mood'));assert.match(t.app.innerHTML,/現在地を確認できませんでした/);assert.equal(JSON.parse(t.memory.get('yorimichi:walks')).length,1);});
test('途中終了時も保存した訪問・メモを維持し、未到着を追加しない',async()=>{const t=await setup();await t.walk();await t.click('simulate');t.app.querySelector('#comment').value='残しておくメモ';await t.submit('reflect-form');await t.click('stop');const walk=JSON.parse(t.memory.get('yorimichi:walks'))[0];assert.equal(walk.places.length,1);assert.equal(walk.places[0].comment,'残しておくメモ');assert.equal(walk.places[0].id,'osm:node/1');assert.equal(walk.status,'stopped');});
test('保存容量不足の場合は、保存できたように見せず警告する',async()=>{const t=await setup({quotaFailure:true});await t.walk();await t.click('stop');assert.match(t.app.innerHTML,/散歩の記録を保存できませんでした/);assert.equal(t.memory.has('yorimichi:walks'),false);});
test('振り返り画面で終了をキャンセルしても入力途中のメモは残る',async()=>{const t=await setup();await t.walk();await t.click('simulate');t.app.querySelector('#comment').value='まだ書いている';t.setConfirm(false);await t.brand.fire('click');assert.equal(t.app.querySelector('#comment').value,'まだ書いている');assert.equal(t.memory.has('yorimichi:walks'),false);});
test('通常の最後まで歩く操作は完了として保存する',async()=>{const t=await setup();await t.walk();for(let i=0;i<2;i++){await t.click('simulate');t.app.querySelector('#comment').value='記録';await t.submit('reflect-form');}assert.match(t.app.innerHTML,/おつかれさまでした/);const record=JSON.parse(t.memory.get('yorimichi:walks'))[0];assert.equal(record.status,'completed');assert.equal(record.places.length,2);assert.equal(JSON.parse(t.memory.get('yorimichi:tracks:v1'))[0].status,'completed');});

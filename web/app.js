import { createTrackStore } from './storage.js';
import { createWalkTracker, trackDistance } from './tracking.js';

export function distanceMeters(a, b) {
  const rad = n => n * Math.PI / 180;
  const dlat = rad(b.lat - a.lat), dlon = rad(b.lon - a.lon);
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dlon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}
export function directionLabel(a, b) {
  const r = n => n * Math.PI / 180;
  const y = Math.sin(r(b.lon - a.lon)) * Math.cos(r(b.lat));
  const x = Math.cos(r(a.lat)) * Math.sin(r(b.lat)) - Math.sin(r(a.lat)) * Math.cos(r(b.lat)) * Math.cos(r(b.lon - a.lon));
  return ['北', '北東', '東', '南東', '南', '南西', '西', '北西'][Math.round((Math.atan2(y, x) * 180 / Math.PI + 360) / 45) % 8];
}
export function escapeHTML(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
export function safeURL(value) {
  try { const u = new URL(value); return u.protocol === 'https:' ? u.href : ''; } catch { return ''; }
}
export function validPoint(p) { return p && Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180; }
export function isArrival(position, target, now = Date.now()) {
  return validPoint(position) && validPoint(target) && Number.isFinite(position.accuracy) && position.accuracy <= 50 &&
    position.accuracy >= 0 && Number.isFinite(position.timestamp) && Math.abs(now - position.timestamp) <= 30000 && distanceMeters(position, target) <= 50;
}
export function validateRoute(data) {
  if (data?.blocked?.message) return data;
  if (!Array.isArray(data?.places) || !data.places.length) throw new Error('条件に合う場所が見つかりませんでした。気分・時間・出発地を変えて試してください。');
  const ids = new Set();
  for (const p of data.places) {
    if (typeof p.id !== 'string' || !p.id || ids.has(p.id) || !validPoint(p) || typeof p.name !== 'string') throw new Error('ルートのデータを読み取れませんでした。もう一度試してください。');
    ids.add(p.id);
  }
  if (typeof data.polyline !== 'string' || !Number.isFinite(data.total_minutes) || data.total_minutes < 0) throw new Error('ルートの形式を確認できませんでした。');
  return data;
}

// ---- 歩いた記録（このブラウザのlocalStorageに保存。将来サーバーのDBへ送るときも同じ形を使う） ----
export const MAX_WALKS = 100, MAX_COMMENT = 500;
// 1回の散歩 = { id, started_at, ended_at, mood, preference, crowd, minutes, mock, places:[訪問] }
// 訪問 = { id(OSM), place_id(Googleの場所ID・nullable), name, kind, lat, lon, visited_at, comment }
// Google由来のデータは place_id だけを残す（maps_uri などは保存しない）。
export function normalizeWalks(list) {
  if (!Array.isArray(list)) return [];
  const str = v => typeof v === 'string' ? v : '';
  return list.filter(w => w && typeof w.id === 'string' && Array.isArray(w.places)).map(w => ({
    id: w.id, started_at: str(w.started_at), ended_at: typeof w.ended_at === 'string' ? w.ended_at : null,
    mood: str(w.mood), preference: str(w.preference), crowd: str(w.crowd),
    minutes: Number.isFinite(w.minutes) ? w.minutes : null, mock: w.mock === true,
    places: w.places.filter(p => p && typeof p.id === 'string' && validPoint(p)).map(p => ({
      id: p.id, place_id: typeof p.place_id === 'string' ? p.place_id : null, name: str(p.name), kind: str(p.kind),
      lat: p.lat, lon: p.lon, visited_at: str(p.visited_at), comment: str(p.comment).slice(0, MAX_COMMENT)
    }))
  })).slice(-MAX_WALKS);
}
export function excludeIds(excluded, visited, limit = 200) {
  // 明示的に外した場所を優先して残すため、後ろに置いてから末尾をとる
  const own = new Set(excluded);
  return [...new Set([...visited.filter(id => !own.has(id)), ...excluded])].slice(-limit);
}

if (typeof document !== 'undefined') boot();
function boot() {
  const app = document.querySelector('#app'), $ = s => app.querySelector(s), esc = escapeHTML;
  const mock = new URLSearchParams(location.search).get('mock') === '1';
  document.querySelector('#mode-badge').textContent = mock ? '見本モード' : '散歩をつくる';
  const storage = {
    get(k, fallback) { try { return JSON.parse(localStorage.getItem(`yorimichi:${k}`)) ?? fallback; } catch { return fallback; } },
    set(k, v) { try { localStorage.setItem(`yorimichi:${k}`, JSON.stringify(v)); } catch { /* 保存不可でも散歩を継続 */ } },
    remove(k) { try { localStorage.removeItem(`yorimichi:${k}`); } catch { /* noop */ } }
  };
  const savedExcluded = storage.get('excluded', []);
  const state = { screen: storage.get('notice', false) ? 'mood' : 'notice', mood: '', preference: '', crowd: 'neutral', minutes: 45,
    origin: {lat:34.9949,lon:135.7850}, excluded: Array.isArray(savedExcluded) ? savedExcluded.filter(x => typeof x === 'string').slice(-200) : [],
    skipVisited: !mock, clarify:null, route:null, index:0, position:null, follow:true, walk:null, lastWalk:null,
    recordTrack:false, trackNotice:'', error:'', geoMessage:'', blocked:'', historyBack:'mood' };
  let controller = null, timer = null, watch = null, map = null, overlays = [], userMarker = null, accuracyCircle = null, originMarker = null,
    routeBounds = null, mapPromise = null, configChecked = false, requestToken = 0, mapsAuthError = false;

  const trackStore = createTrackStore();
  const tracker = createWalkTracker({store:trackStore,onChange:()=>updateTrackStatus()});
  try { trackStore.prune(); } catch(e) { state.trackNotice=e.message; }

  const event = (selector, name, fn) => $(selector)?.addEventListener(name, fn);
  const progress = n => `<div class="step-top"><span class="step-label">${['はじめに','気分をほどく','気分を選ぶ','散歩の準備','散歩'][n]}</span><span class="progress" aria-hidden="true">${[1,2,3].map(i=>`<i class="${i<=n?'active':''}"></i>`).join('')}</span></div>`;
  const errorBox = () => `<div id="error" class="error" role="alert" ${state.error?'':'hidden'}>${esc(state.error)}</div>`;
  const button = (id, text, cls='primary') => `<button id="${id}" class="${cls}" type="button">${text}</button>`;
  const link = (url, text) => safeURL(url) ? `<a href="${esc(safeURL(url))}" target="_blank" rel="noopener noreferrer">${esc(text)} ↗</a>` : '';
  const attribution = () => `<p class="attribution">${[...new Set(['© OpenStreetMap contributors', ...(Array.isArray(state.route?.attributions)?state.route.attributions:[])])].map(a=>`<span>${esc(a)}</span>`).join('')}<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">ライセンス</a></p>`;
  const dateText = iso => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : new Intl.DateTimeFormat('ja-JP',{dateStyle:'medium',timeStyle:'short'}).format(d); };
  const dayText = iso => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '日付不明' : new Intl.DateTimeFormat('ja-JP',{year:'numeric',month:'long',day:'numeric',weekday:'short'}).format(d); };
  const timeText = iso => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : new Intl.DateTimeFormat('ja-JP',{hour:'2-digit',minute:'2-digit'}).format(d); };
  // 表示用の目安。サーバーの概算と同じ「直線距離×1.3÷分速70m」
  const legMinutes = (a, b) => Math.max(1, Math.round(distanceMeters(a, b) * 1.3 / 70));
  const newId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

  function setError(text) { state.error = text; const el = $('#error'); if (el) { el.textContent = text; el.hidden = !text; } }
  function stopWatch() { if (watch !== null) navigator.geolocation?.clearWatch(watch); watch = null; }
  function clearMap() { for (const o of overlays) o.setMap(null); overlays=[]; userMarker=null; accuracyCircle=null; originMarker=null; routeBounds=null; if(map) google.maps.event.clearInstanceListeners(map); map=null; }
  function go(screen) { state.screen = screen; state.error=''; render(); app.focus({preventScroll:true}); }
  function mapMarkup(extraClass='') { return `<div id="map" class="map ${extraClass}" aria-label="地図"></div><p id="map-label" class="map-label" hidden></p>`; }
  function setMapLabel(text) { const el=$('#map-label'); if(el){el.textContent=text;el.hidden=!text;} }

  // ---- 歩いた記録 ----
  function loadWalks() { return normalizeWalks(storage.get('walks', [])); }
  function saveWalk(w) { storage.set('walks', [...loadWalks().filter(x => x.id !== w.id), w].slice(-MAX_WALKS)); }
  function visitedIds() { return [...new Set(loadWalks().filter(w => w.mock === mock).flatMap(w => w.places.map(p => p.id)))]; }
  function startWalkRecord() {
    state.walk = { id:newId(), started_at:new Date().toISOString(), ended_at:null, mood:state.mood, preference:state.preference,
      crowd:state.crowd, minutes:state.minutes, mock, places:[] };
    tracker.start(state.walk.id,{enabled:state.recordTrack,mock});
  }
  function recordVisit(p, comment) {
    const w = state.walk; if (!w) return;
    const entry = { id:p.id, place_id:typeof p.place_id==='string'?p.place_id:null, name:p.name, kind:typeof p.kind==='string'?p.kind:'',
      lat:p.lat, lon:p.lon, visited_at:new Date().toISOString(), comment:comment.slice(0, MAX_COMMENT) };
    w.places = [...w.places.filter(x => x.id !== p.id), entry];
    saveWalk(w); // 途中で画面を閉じても、着いた場所までは残る
  }
  function finishWalk() {
    tracker.finish('completed');
    const w = state.walk; state.walk = null; state.lastWalk = w;
    if (w && w.places.length) { w.ended_at = new Date().toISOString(); saveWalk(w); }
  }

  function render() {
    clearInterval(timer); clearMap(); app.removeAttribute('aria-busy');
    const s = state.screen;
    if (s === 'notice') {
      app.innerHTML = `${progress(0)}<h2>歩く前に、<br>小さな約束を。</h2><ul class="notice-list"><li><b>画面を見るときは、立ち止まる。</b><p>歩いている間は、街の景色を楽しんでください。</p></li><li><b>入れる場所か、その場で確かめる。</b><p>営業時間や立入制限は変わります。看板・現地の案内を優先してください。</p></li><li><b>気が進まなければ、引き返す。</b><p>暗い道や不安な場所を避け、無理のない散歩を。</p></li></ul>${button('accept','わかりました、はじめる')}<p class="subtle">歩いている間の現在地はブラウザの中で処理し、自分たちのサーバーには送りません。「歩いた道を保存する」を選ぶと、位置履歴をこのブラウザに保存します。出発地のみ、ルート作成時にサーバーへ送ります。立ち寄った場所とメモは、このブラウザに「歩いた記録」として保存します。</p>`;
      event('#accept','click',()=>{storage.set('notice',true);go('mood');});
    } else if (s === 'mood') {
      const walks = loadWalks();
      app.innerHTML = `${progress(1)}<h2>今日は、<br>どんな気分ですか。</h2><p class="lead">うまく言葉にならなくても、大丈夫。<br>いま思い浮かんだ、一言から。</p><form id="mood-form"><label for="mood" class="field">いまの気分</label><textarea id="mood" class="text-field" maxlength="200" required placeholder="たとえば、キラキラ。少し懐かしい。">${esc(state.mood)}</textarea><p class="subtle">「緑を感じたい」「映画の中みたいな」でも。</p>${errorBox()}<button class="primary" type="submit">気分をほどく</button></form>${walks.length||loadTracks().length?button('history',`歩いた記録を見る（${walks.length}回）`,'text-button'):''}`;
      event('#mood-form','submit',async e=>{e.preventDefault();state.mood=$('#mood').value.trim();if(!state.mood)return setError('いまの気分を一言入力してください。');await request('clarify',{mood:state.mood},'choices','mood');});
      event('#history','click',()=>{state.historyBack='mood';go('history');});
    } else if (s === 'choices') {
      app.innerHTML = `${progress(2)}<span class="pill">${esc(state.mood)}</span><h2>${esc(state.clarify.question)}</h2><p class="lead">いまの自分に近いものを、ひとつ。</p><div>${state.clarify.options.map((o,i)=>`<button type="button" class="choice" data-option="${i}">${esc(o.label)}</button>`).join('')}</div><div class="divider">自分の言葉でも</div><form id="preference-form"><label class="field" for="preference">もう少し伝える</label><input id="preference" class="text-field" maxlength="200" placeholder="どんなふうに過ごしたい？" value="${esc(state.preference)}"><label class="field" for="crowd">人の多さは？</label><select id="crowd" class="text-field"><option value="neutral">どちらでも</option><option value="avoid">混雑を避けたい</option><option value="ok">にぎやかでいい</option></select>${errorBox()}<button type="submit" class="primary">この気分で歩く</button></form><div class="actions">${button('back','戻る','text-button')}${button('surprise','おまかせ','text-button')}</div>`;
      app.querySelectorAll('[data-option]').forEach(b=>b.addEventListener('click',()=>{const o=state.clarify.options[Number(b.dataset.option)];state.preference=o.label;state.crowd=o.crowd;go('setup');}));
      event('#preference-form','submit',e=>{e.preventDefault();state.preference=$('#preference').value.trim();if(!state.preference)return setError('気分を入力するか、選択肢・おまかせを選んでください。');state.crowd=$('#crowd').value;go('setup');});
      event('#surprise','click',()=>{state.preference=state.mood;state.crowd='neutral';go('setup');});event('#back','click',()=>go('mood'));
    } else if (s === 'setup') {
      const visited = visitedIds();
      app.innerHTML = `${progress(3)}<h2>どこから、<br>どのくらい歩こう。</h2><p class="lead">${esc(state.preference)}</p><form id="setup-form"><fieldset style="border:0;padding:0;margin:0"><legend class="field">散歩の時間</legend><div class="duration-options">${[30,45,60].map(n=>`<label class="duration-option"><input type="radio" name="minutes" value="${n}" ${state.minutes===n?'checked':''}><span>${n}分</span></label>`).join('')}</div></fieldset><label class="field">出発地</label>${button('locate','◎ 現在地を使う','secondary')}<p id="geo-status" class="subtle" role="status">${mock?'見本モードでは、出発地を変えても見本の場所は同じです。':'地図をタップするか、座標を入力してください。'}</p>${mapMarkup()}<div class="coords"><div><label for="lat" class="field">緯度</label><input id="lat" class="text-field" type="number" step="any" min="-90" max="90" required value="${state.origin.lat}"></div><div><label for="lon" class="field">経度</label><input id="lon" class="text-field" type="number" step="any" min="-180" max="180" required value="${state.origin.lon}"></div></div>${visited.length?`<label class="check"><input id="skip-visited" type="checkbox" ${state.skipVisited?'checked':''}><span>前に行った場所（${visited.length}か所）は候補から外す</span></label>`:''}${errorBox()}<button class="primary" type="submit">ルートをつくる</button></form>${button('back','気分の選択に戻る','text-button')}${state.excluded.length?button('clear-excluded','外した場所の記録をリセット','text-button'):''}`;
      event('#locate','click',locate);event('#back','click',()=>go('choices'));
      event('#clear-excluded','click',()=>{state.excluded=[];storage.set('excluded',[]);go('setup');});
      event('#setup-form','submit',async e=>{e.preventDefault();state.origin={lat:Number($('#lat').value),lon:Number($('#lon').value)};state.minutes=Number(new FormData(e.target).get('minutes'));if($('#skip-visited'))state.skipVisited=$('#skip-visited').checked;if(!validPoint(state.origin))return setError('出発地の座標を確認してください。');await createRoute('setup');});
      setupMap().catch(e=>setError(e.message));
    } else if (s === 'loading') {
      app.setAttribute('aria-busy','true');app.innerHTML=`${progress(state.pending==='clarify'?1:3)}<div class="waiting"><div class="loader" aria-hidden="true"></div><p class="waiting-word">「${esc(state.mood)}」</p><h2>${state.pending==='clarify'?'この言葉を、<br>ほどいています。':'この言葉から、<br>近所を探しています。'}</h2><p id="waiting-text" class="lead" role="status">${mock?'見本データを読み込んでいます。':'少しだけ、お待ちください。'}</p><p class="time"><span id="elapsed">0</span>秒経過</p><p class="subtle">${mock?'このモードではAI・場所検索・ルートのAPIを呼びません。':'通常10〜40秒ほど。混雑時は長くかかることがあります。'}</p>${button('cancel','キャンセル','text-button')}</div>`;
      const start=Date.now();timer=setInterval(()=>{const t=Math.floor((Date.now()-start)/1000);$('#elapsed').textContent=t;if(t>=10)$('#waiting-text').textContent=t>=40?'時間がかかっています。キャンセルしてやり直すこともできます。':'まだ処理中です。もう少しお待ちください。';},1000);
      event('#cancel','click',()=>{requestToken++;controller?.abort();go(state.returnScreen);});
    } else if (s === 'route') {
      app.innerHTML=`${progress(4)}<div class="summary"><h2>今日の、よりみち。</h2><p class="summary-time"><strong>${esc(Math.round(state.route.total_minutes))}</strong>分</p></div><p class="lead">${esc(state.route.interpretation)}</p>${mapMarkup()}${attribution()}<div id="route-details" ${mock?'':'hidden'}><ol class="trail"><li class="trail-start"><span class="trail-dot" aria-hidden="true"></span><b>出発地</b></li>${state.route.places.map((p,i)=>{const prev=i?state.route.places[i-1]:state.origin;return `<li class="trail-leg">徒歩 約${legMinutes(prev,p)}分（直線 ${formatDistance(distanceMeters(prev,p))}）</li><li class="trail-stop"><span class="trail-dot" aria-hidden="true">${i+1}</span><div class="trail-body"><span class="place-kind">${esc(p.kind)}</span><h3>${esc(p.name)}</h3><p>${esc(p.hint)}</p>${p.warning?`<p class="warning">${esc(p.warning)}</p>`:''}${link(p.maps_uri,'Google Mapsで見る')}</div><button type="button" class="remove" data-remove="${i}" aria-label="${esc(p.name)}を外す">外す</button></li>`;}).join('')}</ol><div class="sources">${(state.route.sources||[]).map(x=>link(x.uri,x.title)).join(' ')}</div></div>${errorBox()}<label class="check"><input id="save-track" type="checkbox" ${state.recordTrack?'checked':''}><span>歩いた道をこのブラウザに保存する</span></label><p class="subtle">選択した場合のみ、歩行中の緯度・経度・時刻・位置精度を保存します。7日間・最大20回。画面を閉じた後の追跡はできません。</p><button id="start" type="button" class="primary go" ${mock?'':'disabled'}>歩きはじめる</button><p class="subtle">所要時間は滞在を含む目安です。実際の道順は地図と現地で確認してください。</p>${button('back','時間・出発地を変更する','text-button')}`;
      event('#start','click',()=>{state.recordTrack=$('#save-track').checked;state.index=0;state.position=null;state.geoMessage='';state.follow=true;startWalkRecord();go('walk');startWatch();});event('#back','click',()=>go('setup'));
      app.querySelectorAll('[data-remove]').forEach(b=>b.addEventListener('click',async()=>{const id=state.route.places[Number(b.dataset.remove)].id;state.excluded=[...new Set([...state.excluded,id])].slice(-200);storage.set('excluded',state.excluded);await createRoute('route');}));
      resultMap().then(()=>{if(state.screen==='route'&&!mapsAuthError){$('#route-details').hidden=false;$('#start').disabled=false;}}).catch(e=>setError(e.message));
    } else if (s === 'walk') {
      const p=state.route.places[state.index];
      app.innerHTML=`<div class="walk-screen"><div class="walk-map-wrap"><div id="map" class="map walk-map" aria-label="地図"></div><div class="map-notes">${attribution()}<p id="map-label" class="map-label" hidden></p></div><div id="map-tools" class="map-tools" hidden>${button('recenter','◎ 現在地に戻る','map-button')}${button('overview','ルート全体','map-button')}</div></div><section class="sheet" aria-label="次の場所"><span class="sheet-handle" aria-hidden="true"></span><p class="sheet-step">${state.index+1} / ${state.route.places.length} か所目</p><p id="walk-distance" class="walk-distance"></p><p id="walk-direction" class="walk-direction"></p><div id="walk-details" class="next-place" ${mock?'':'hidden'}><h3>${esc(p.name)}</h3><p>${esc(p.hint)}</p>${p.warning?`<p class="warning">${esc(p.warning)}</p>`:''}</div><p id="geo-status" class="geo-status" role="status"></p><p id="track-status" class="subtle" role="status"></p>${button('stop-track','歩いた道の保存を停止','text-button')}${errorBox()}<div class="sheet-action">${button('arrive','着いた','primary')}</div><p class="subtle">画面を見るときは立ち止まってください。距離と方角は直線で、道案内ではありません。</p>${mock?`<div class="mock-tools"><p>見本モードの操作確認</p>${button('simulate','この場所への到着を再現','secondary')}</div>`:''}<div class="sheet-links">${button('watch','現在地を取得し直す','text-button')}${button('stop','散歩を終了する','text-button')}</div></section></div>`;
      resultMap().then(()=>{if(state.screen==='walk'&&!mapsAuthError)$('#walk-details').hidden=false;}).catch(e=>setError(e.message));
      updateWalk();event('#arrive','click',arrive);event('#simulate','click',()=>{const pos={...p,accuracy:10,timestamp:Date.now(),simulated:true};receivePosition(pos);});event('#watch','click',startWatch);event('#stop','click',()=>{stopWatch();finishWalk();go('done');});
      event('#stop-track','click',()=>tracker.finish('stopped'));
      event('#recenter','click',()=>{state.follow=true;if(state.position){map?.panTo({lat:state.position.lat,lng:state.position.lon});map?.setZoom(17);}else startWatch();});
      event('#overview','click',()=>{state.follow=false;if(map&&routeBounds)map.fitBounds(routeBounds,35);});
    } else if (s === 'reflect') {
      const p=state.route.places[state.index], last=state.index+1>=state.route.places.length;
      app.innerHTML=`${progress(4)}<p class="sheet-step">${state.index+1} / ${state.route.places.length} か所目　${esc(p.name)}</p><h2 class="question">求めていた<br>「${esc(state.mood)}」は、<br>感じられた？</h2><form id="reflect-form"><label for="comment" class="field">ひとことメモ</label><textarea id="comment" class="notebook" maxlength="${MAX_COMMENT}" placeholder="書かなくても大丈夫。たとえば、思ったより静かだった。"></textarea><p class="subtle">立ち寄った場所とメモは「歩いた記録」としてこのブラウザに保存されます。</p><button class="primary${last?'':' go'}" type="submit">${last?'記録して散歩を終える':'記録して次へ歩く'}</button></form>${button('not-yet','まだ着いていない','text-button')}`;
      event('#reflect-form','submit',e=>{e.preventDefault();recordVisit(p,$('#comment').value.trim());nextPlace();});
      event('#not-yet','click',()=>{state.follow=true;go('walk');startWatch();});
    } else if (s === 'done') {
      const n=state.lastWalk?.places.length??0;
      app.innerHTML=`${progress(4)}<div class="finish-mark" aria-hidden="true">↗</div><h2>おつかれさまでした。</h2><p class="lead">いつもの街に、<br>少しだけ違う景色が増えたなら。</p>${n?`<p class="subtle">今回は${n}か所に立ち寄り、歩いた記録に残しました。</p>`:''}${button('again','また、よりみちする')}${button('history','歩いた記録を見る','secondary wide')}${button('erase','このブラウザの歩いた記録・外した場所を消す','text-button')}<p id="erase-status" class="subtle" role="status"></p>`;
      event('#again','click',()=>{state.route=null;state.position=null;go('mood');});
      event('#history','click',()=>{state.historyBack='done';go('history');});
      event('#erase','click',()=>{if(!confirm('歩いた記録と外した場所の記録を消します。位置履歴も削除します。元に戻せません。よろしいですか？'))return;storage.remove('walks');storage.remove('ratings');tracker.clearAll();storage.set('excluded',[]);state.excluded=[];$('#erase-status').textContent=tracker.status().error||'歩いた記録・位置履歴・外した場所の記録を消しました。';});
    } else if (s === 'history') {
      const walks=loadWalks().reverse(), count=walks.reduce((a,w)=>a+w.places.length,0), days=[];
      for(const w of walks){const day=dayText(w.started_at),g=days[days.length-1];if(g&&g.day===day)g.walks.push(w);else days.push({day,walks:[w]});}
      app.innerHTML=`<h2 class="diary-title">歩いた記録</h2><p class="lead">${walks.length?`${walks.length}回の散歩で、${count}か所に立ち寄りました。このブラウザにだけ保存されています。`:'まだ記録はありません。散歩で場所に着くと、ここに残ります。'}</p>${days.map(g=>`<section class="diary-day"><h3 class="diary-date">${esc(g.day)}</h3><ol class="walk-log">${g.walks.map(w=>`<li><p class="walk-log-head"><time datetime="${esc(w.started_at)}">${esc(timeText(w.started_at))}</time>${w.mock?'<span class="badge">見本</span>':''}</p><p class="walk-log-mood">「${esc(w.mood)}」</p>${w.preference&&w.preference!==w.mood?`<p class="walk-log-pref">${esc(w.preference)}</p>`:''}<ul class="visit-list">${w.places.map(p=>`<li><span class="place-kind">${esc(p.kind)}</span><b>${esc(p.name)}</b>${p.comment?`<p class="note">${esc(p.comment)}</p>`:''}</li>`).join('')}</ul></li>`).join('')}</ol></section>`).join('')}${trackHistoryMarkup()}${button('back','戻る','secondary wide')}${walks.length?button('erase-walks','歩いた記録をすべて消す','text-button'):''}`;
      event('#back','click',()=>go(state.historyBack));
      event('#erase-tracks','click',()=>{if(!confirm('このブラウザに保存した位置履歴をすべて削除しますか？'))return;tracker.clearAll();go('history');if(tracker.status().error)setError(tracker.status().error);});
      event('#erase-walks','click',()=>{if(!confirm('歩いた記録をすべて消します。元に戻せません。よろしいですか？'))return;storage.remove('walks');go('history');});
    } else if(s === 'blocked') {
      stopWatch();app.innerHTML=`<div class="blocked"><p role="alert">${esc(state.blocked)}</p></div>`;
    }
  }
  function loadTracks() {
    try { return trackStore.list(); } catch(e) { state.trackNotice=e.message;return []; }
  }
  function updateTrackStatus() {
    const info=tracker.status(),el=$('#track-status'),stop=$('#stop-track');
    if(el)el.textContent=info.error?`保存エラー：${info.error} 位置履歴の保存を停止しました。`:info.active?`歩いた道を保存中：${info.count}点。精度100m以内の位置を、10秒以上・移動5m以上の間隔で記録します。静止中は最短60秒ごと。`:info.status==='limit'?'1回の上限（1,200点）に達したため、保存を停止しました。':info.status==='stopped'?`保存を停止しました（${info.count}点）。現在地の表示は続けます。`:'移動中の位置は保存していません。';
    if(stop)stop.hidden=!info.active;
  }
  function trackHistoryMarkup() {
    const tracks=loadTracks().reverse();
    const items=tracks.map(t=>{
      const length=t.points.slice(1).reduce((n,p,i)=>n+trackDistance(t.points[i],p),0);
      return `<li><time>${esc(dateText(new Date(t.started_at).toISOString()))}</time> ${t.mock?'（見本）':''}<p>${t.points.length}点・記録点を結んだ距離 ${esc(formatDistance(length))}</p></li>`;
    }).join('');
    return `<section><h3>歩いた道の記録</h3><p class="subtle">このブラウザにだけ保存。最短10秒間隔、1回1,200点、合計6,000点、20回、7日間まで。古い記録はアプリを開いたとき・保存時に整理します。位置のずれや欠落があり、距離は目安です。</p>${state.trackNotice?`<p class="warning">${esc(state.trackNotice)}</p>`:''}${tracks.length?`<ul>${items}</ul>${button('erase-tracks','位置履歴をすべて削除する','text-button')}`:'<p class="subtle">位置履歴はまだありません。</p>'}</section>`;
  }

  function formatDistance(m) { return m>=1000?`${(m/1000).toFixed(1)} km`:`${Math.round(m)} m`; }
  function routeBody() { return {mood:state.mood,preference:state.preference,crowd:state.crowd,lat:state.origin.lat,lon:state.origin.lon,minutes:state.minutes,exclude_ids:excludeIds(state.excluded,state.skipVisited?visitedIds():[]),include_ids:[]}; }
  async function createRoute(back) { await request('route',routeBody(),'route',back); }
  async function request(endpoint, body, success, back) {
    const token=++requestToken;state.returnScreen=back;state.pending=endpoint;controller=new AbortController();const aborter=controller;
    go('loading');const timeout=setTimeout(()=>aborter.abort(),65000);
    try {
      const response=await fetch(mock?`./mock/${endpoint}.json`:`/api/${endpoint}`,mock?{signal:aborter.signal,cache:'no-store'}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:aborter.signal});
      let data;try{data=await response.json();}catch{throw new Error('サーバーからの応答を読み取れませんでした。接続先を確認してください。');}
      if(!response.ok)throw new Error(response.status===429?'利用回数の上限です。少し時間をおいてください。':(typeof data.error==='string'?data.error:'処理に失敗しました。もう一度試してください。'));
      if(token!==requestToken)return;
      if(data.blocked?.message){state.blocked=data.blocked.message;go('blocked');return;}
      if(endpoint==='clarify') {
        if(typeof data.question!=='string'||!Array.isArray(data.options)||data.options.length<1||data.options.some(o=>typeof o.label!=='string'||!['avoid','neutral','ok'].includes(o.crowd)))throw new Error('選択肢を読み取れませんでした。もう一度試してください。');
        state.clarify=data;
      } else {
        if(mock){data.places=data.places.filter(p=>!body.exclude_ids.includes(p.id));data.total_minutes=Math.min(body.minutes,10*data.places.length+8);}
        state.route=validateRoute(data);
      }
      go(success);
    } catch(e) { if(token!==requestToken)return;go(back);setError(e.name==='AbortError'?'応答が時間内に届きませんでした。もう一度試してください。':e.message||'通信できませんでした。接続を確認してください。'); }
    finally {clearTimeout(timeout);if(token===requestToken)controller=null;}
  }

  // ---- Googleマップ ----
  async function loadConfig() {
    if(window.MAPS_JS_API_KEY||configChecked)return;configChecked=true;
    await new Promise(resolve=>{const script=document.createElement('script');script.src='./config.js';script.onload=resolve;script.onerror=resolve;document.head.append(script);});
  }
  function loadMaps() {
    if(mapsAuthError)return Promise.reject(new Error('Googleマップの認証に失敗しています。キーの設定後、ページを再読み込みしてください。'));
    if(window.google?.maps?.geometry)return Promise.resolve();
    if(mapPromise)return mapPromise;
    mapPromise=(async()=>{
      await loadConfig();
      if(!window.MAPS_JS_API_KEY)throw new Error('Googleマップの設定がありません。web/config.jsを設定してください。見本はURL末尾に ?mock=1 を付けて試せます。');
      await new Promise((resolve,reject)=>{
        const script=document.createElement('script');const timeout=setTimeout(()=>{script.remove();reject(new Error('Googleマップの読み込みが時間切れになりました。'));},20000);
        const fail=()=>{clearTimeout(timeout);reject(new Error('Googleマップを読み込めませんでした。キーのAPI制限・URL制限を確認してください。'));};
        window.yorimichiMapReady=()=>{clearTimeout(timeout);resolve();};
        window.gm_authFailure=()=>{
          mapsAuthError=true;fail();
          if(mock){render();return;} // 見本モードは模式図に切り替える
          $('#walk-details')?.setAttribute('hidden','');$('#route-details')?.setAttribute('hidden','');if($('#start'))$('#start').disabled=true;setError('Googleマップの認証に失敗しました。キーの設定を確認してください。');
        };
        const params=new URLSearchParams({key:window.MAPS_JS_API_KEY,callback:'yorimichiMapReady',libraries:'geometry',v:'weekly',language:'ja',loading:'async'});
        script.src=`https://maps.googleapis.com/maps/api/js?${params}`;script.onerror=fail;document.head.append(script);
      });
    })().catch(e=>{mapPromise=null;throw e;});return mapPromise;
  }
  // 通常モードはGoogleマップ必須。見本モードはconfig.jsにキーがあればGoogleマップ、なければ模式図。
  async function prepareMap() {
    if(!mock){await loadMaps();return 'google';}
    try{await loadMaps();return 'google';}catch{return 'mock';}
  }
  function newMap(container, center, zoom=15) {
    return new google.maps.Map(container,{center,zoom,streetViewControl:false,mapTypeControl:false,fullscreenControl:false,clickableIcons:false,gestureHandling:'greedy'});
  }
  function mockMap() {
    const el=$('#map');if(!el)return;el.classList.add('mock-map');const places=['route','walk'].includes(state.screen)?state.route.places:[];
    el.innerHTML=`<svg viewBox="0 0 440 250" preserveAspectRatio="xMidYMid slice" role="img" aria-label="道路ではない操作確認用の模式図"><rect class="mock-ground" width="440" height="250"/><path class="mock-road" d="M-10 60L450 170M70 -10L190 270M310 -10L200 270M-10 220L450 55"/><path class="mock-park" d="M300 32Q382 20 377 95Q370 146 318 127Z"/><path class="map-line" d="M85 190 Q130 136 200 151 T345 75"/><circle class="map-pin" cx="85" cy="190" r="9"/>${places.map((p,i)=>`<circle class="map-pin" cx="${150+i*65}" cy="${165-i*30}" r="13"/><text class="map-pin-label" x="${150+i*65}" y="${169-i*30}" text-anchor="middle">${i+1}</text>`).join('')}<text class="map-note" x="20" y="28">KYOTO / SAMPLE</text><text class="map-note" x="20" y="232">見本の模式図。実際の道路とは異なります</text></svg>`;
    setMapLabel('見本の模式図です。config.jsにキーを設定すると、見本モードでもGoogleマップを表示します。');
  }
  async function setupMap() {
    const container=$('#map');const kind=await prepareMap();if(state.screen!=='setup'||$('#map')!==container)return;
    if(kind==='mock'){mockMap();return;}
    map=newMap(container,{lat:state.origin.lat,lng:state.origin.lon});
    originMarker=new google.maps.Marker({map,position:{lat:state.origin.lat,lng:state.origin.lon},title:'出発地'});overlays.push(originMarker);
    map.addListener('click',e=>{state.origin={lat:e.latLng.lat(),lon:e.latLng.lng()};$('#lat').value=state.origin.lat.toFixed(6);$('#lon').value=state.origin.lon.toFixed(6);originMarker.setPosition(e.latLng);});
    const update=()=>{const point={lat:Number($('#lat').value),lon:Number($('#lon').value)};if(validPoint(point)){state.origin=point;originMarker.setPosition({lat:point.lat,lng:point.lon});map.panTo({lat:point.lat,lng:point.lon});}};
    event('#lat','change',update);event('#lon','change',update);
  }
  async function resultMap() {
    const screen=state.screen,container=$('#map');const kind=await prepareMap();if(state.screen!==screen||$('#map')!==container)return;
    if(kind==='mock'){mockMap();return;}
    map=newMap(container,{lat:state.origin.lat,lng:state.origin.lon});
    const bounds=new google.maps.LatLngBounds();const start={lat:state.origin.lat,lng:state.origin.lon};bounds.extend(start);
    const path=google.maps.geometry.encoding.decodePath(state.route.polyline);
    if(path.length<2)throw new Error('歩く道の線を読み取れませんでした。もう一度ルートを作ってください。');
    overlays.push(new google.maps.Polyline({map,path,strokeColor:'#294d3c',strokeWeight:5,strokeOpacity:.9}));path.forEach(p=>bounds.extend(p));
    overlays.push(new google.maps.Marker({map,position:start,title:'出発地',label:'発'}));
    state.route.places.forEach((p,i)=>{
      const position={lat:p.lat,lng:p.lon};bounds.extend(position);
      const isNext=screen==='walk'&&i===state.index, passed=screen==='walk'&&i<state.index;
      overlays.push(new google.maps.Marker({map,position,label:String(i+1),title:p.name,opacity:passed?.45:1,zIndex:isNext?100:1}));
    });
    routeBounds=bounds;
    if(mock)setMapLabel('見本のルート線は場所を直線で結んだもので、実際の道ではありません。');
    if(screen!=='walk'){map.fitBounds(bounds,35);return;}
    // 歩行中：現在地（なければ出発地）と次の場所が収まるように表示し、以後は現在地を追いかける
    map.addListener('dragstart',()=>{state.follow=false;});
    const next=state.route.places[state.index],from=state.position||state.origin,view=new google.maps.LatLngBounds();
    view.extend({lat:from.lat,lng:from.lon});view.extend({lat:next.lat,lng:next.lon});map.fitBounds(view,60);
    google.maps.event.addListenerOnce(map,'idle',()=>{if(map.getZoom()>18)map.setZoom(18);});
    $('#map-tools').hidden=false;
    if(state.position)updateUserMarker(false);
  }
  function updateUserMarker(pan=true) {
    if(!map||!state.position||!window.google?.maps)return;const p={lat:state.position.lat,lng:state.position.lon};
    if(userMarker){userMarker.setPosition(p);accuracyCircle.setCenter(p);accuracyCircle.setRadius(state.position.accuracy||0);}
    else{
      accuracyCircle=new google.maps.Circle({map,center:p,radius:state.position.accuracy||0,strokeOpacity:0,fillColor:'#3978c2',fillOpacity:.15,clickable:false});
      userMarker=new google.maps.Marker({map,position:p,title:'現在地',zIndex:200,icon:{path:google.maps.SymbolPath.CIRCLE,scale:7,fillColor:'#3978c2',fillOpacity:1,strokeColor:'white',strokeWeight:2}});
      overlays.push(accuracyCircle,userMarker);
    }
    if(pan&&state.follow)map.panTo(p);
  }

  // ---- 位置情報 ----
  function geoErrorText(err) {
    if(!window.isSecureContext)return '現在地は https:// または localhost で開いたときだけ使えます。';
    if(err?.code===1)return '位置情報の利用が許可されていません。ブラウザと端末の設定で、このサイトの位置情報を許可してください。';
    if(err?.code===3)return '現在地の取得が時間切れになりました。屋外や窓の近くで、もう一度試してください。';
    return '現在地を取得できませんでした。';
  }
  function locate() {
    if(!navigator.geolocation)return setError('このブラウザでは現在地を取得できません。地図か座標で指定してください。');
    if(!window.isSecureContext){$('#geo-status').textContent=geoErrorText();return;}
    const b=$('#locate');b.disabled=true;$('#geo-status').textContent='現在地を確認しています…';
    navigator.geolocation.getCurrentPosition(pos=>{
      if(state.screen!=='setup')return;b.disabled=false;
      state.origin={lat:pos.coords.latitude,lon:pos.coords.longitude};$('#lat').value=state.origin.lat.toFixed(6);$('#lon').value=state.origin.lon.toFixed(6);
      $('#geo-status').textContent=`現在地を出発地にしました（精度：約${Math.round(pos.coords.accuracy)}m）。${mock?'見本モードでは、見本の場所は変わりません。':''}`;
      if(map&&originMarker){const p={lat:state.origin.lat,lng:state.origin.lon};originMarker.setPosition(p);map.panTo(p);map.setZoom(16);}
    },err=>{if(state.screen!=='setup')return;b.disabled=false;$('#geo-status').textContent=`${geoErrorText(err)} 地図をタップするか、座標で指定できます。`;},{enableHighAccuracy:true,timeout:12000,maximumAge:0});
  }
  function startWatch() {
    stopWatch();if(state.screen!=='walk')return;
    if(!navigator.geolocation||!window.isSecureContext){state.geoMessage=`${navigator.geolocation?geoErrorText():'このブラウザでは現在地を取得できません。'}「着いた」ボタンで進めます。`;updateWalk();return;}
    state.geoMessage='現在地を確認しています…';updateWalk();
    watch=navigator.geolocation.watchPosition(p=>receivePosition({lat:p.coords.latitude,lon:p.coords.longitude,accuracy:p.coords.accuracy,timestamp:p.timestamp}),err=>{state.geoMessage=`${geoErrorText(err)}「着いた」ボタンで進めます。`;updateWalk();},{enableHighAccuracy:true,timeout:15000,maximumAge:5000});
  }
  function receivePosition(p) {
    if(state.screen!=='walk'||!validPoint(p))return;tracker.record(p);state.position=p;state.geoMessage=`現在地を表示中（精度：約${Math.round(p.accuracy)}m${p.accuracy>50?'。精度が低いため自動の到着判定を保留しています':''}）`;
    if(isArrival(p,state.route.places[state.index])){arrive();return;}updateWalk();
  }
  function updateWalk() {
    if(state.screen!=='walk')return;updateTrackStatus();updateUserMarker();const p=state.route.places[state.index],from=state.position||state.origin;
    $('#walk-distance').innerHTML=`${esc(formatDistance(distanceMeters(from,p)).replace(/ (m|km)$/,''))}<small>${distanceMeters(from,p)>=1000?'km':'m'}</small>`;
    $('#walk-direction').textContent=`${state.position?'現在地':'出発地'}から直線・${directionLabel(from,p)}の方角`;
    $('#geo-status').textContent=state.geoMessage||'現在地はまだ取得していません。「着いた」でも進めます。';
  }
  function arrive() {stopWatch();go('reflect');}
  function nextPlace() {state.index++;state.geoMessage='';state.follow=true;if(state.index>=state.route.places.length){stopWatch();finishWalk();go('done');}else{go('walk');startWatch();}}
  window.addEventListener('pagehide',()=>{tracker.finish('interrupted');stopWatch();controller?.abort();clearInterval(timer);});
  render();
}
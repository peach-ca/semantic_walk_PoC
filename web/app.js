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

// ---- ルートの線に沿った距離（道のり） ----
// Routes APIのencodedPolylineをブラウザの中で復号し、線に沿って距離を測る。追加のAPI呼び出しはしない。
export function decodePolyline(str) {
  const pts = []; let i = 0, lat = 0, lon = 0;
  if (typeof str !== 'string') return pts;
  while (i < str.length) {
    const deltas = [];
    for (let k = 0; k < 2; k++) {
      let shift = 0, result = 0, b;
      do {
        if (i >= str.length) return [];
        b = str.charCodeAt(i++) - 63;
        if (b < 0 || b > 63) return [];
        result |= (b & 0x1f) << shift; shift += 5;
      } while (b >= 0x20);
      deltas.push(result & 1 ? ~(result >> 1) : result >> 1);
    }
    lat += deltas[0]; lon += deltas[1];
    pts.push({lat: lat / 1e5, lon: lon / 1e5});
  }
  return pts.every(validPoint) ? pts : [];
}
export function measurePath(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + distanceMeters(pts[i - 1], pts[i]));
  return cum;
}
// 点pに最も近い線上の位置。from〜toの区間だけを探す（同じ道を往復するルートで、先の区間に飛ばないように）。
export function locateOnPath(pts, cum, p, from = 0, to = pts.length - 2) {
  let best = {seg: Math.max(0, from), along: cum[Math.max(0, from)] ?? 0, offset: Infinity};
  for (let i = Math.max(0, from); i <= Math.min(to, pts.length - 2); i++) {
    const a = pts[i], b = pts[i + 1], kx = Math.cos(a.lat * Math.PI / 180) * 111320, ky = 110540;
    const bx = (b.lon - a.lon) * kx, by = (b.lat - a.lat) * ky, px = (p.lon - a.lon) * kx, py = (p.lat - a.lat) * ky;
    const len2 = bx * bx + by * by, t = len2 ? Math.max(0, Math.min(1, (px * bx + py * by) / len2)) : 0;
    const offset = Math.hypot(px - t * bx, py - t * by);
    if (offset < best.offset) best = {seg: i, along: cum[i] + t * (cum[i + 1] - cum[i]), offset};
  }
  return best;
}
// 線を、指定した距離のところで「通ったところ」と「これから」に分ける。
export function splitPath(pts, cum, along) {
  if (!(along > 0)) return [[pts[0]], pts.slice()];
  const i = cum.findIndex(c => c >= along);
  if (i === -1) return [pts.slice(), [pts[pts.length - 1]]];
  if (i === 0) return [[pts[0]], pts.slice()];
  const t = (along - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1), a = pts[i - 1], b = pts[i];
  const m = {lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t};
  return [[...pts.slice(0, i), m], [m, ...pts.slice(i)]];
}
export function routeGeometry(route, origin) {
  const pts = decodePolyline(route?.polyline);
  if (pts.length < 2) return null;
  const cum = measurePath(pts), o = locateOnPath(pts, cum, origin);
  let seg = o.seg;
  const places = route.places.map(p => { const r = locateOnPath(pts, cum, p, seg); seg = r.seg; return r; });
  return {pts, cum, origin: o, places};
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
    status: ['completed','stopped','interrupted'].includes(w.status) ? w.status : (w.ended_at ? 'completed' : 'interrupted'),
    elapsed_seconds: Number.isFinite(w.elapsed_seconds) && w.elapsed_seconds >= 0 ? w.elapsed_seconds : null,
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
    set(k, v) { try { localStorage.setItem(`yorimichi:${k}`, JSON.stringify(v)); return true; } catch { return false; } },
    remove(k) { try { localStorage.removeItem(`yorimichi:${k}`); } catch { /* noop */ } }
  };
  const savedExcluded = storage.get('excluded', []);
  const state = { screen: storage.get('notice', false) ? 'mood' : 'notice', mood: '', preference: '', crowd: 'neutral', minutes: 45,
    origin: mock ? {lat:34.9949,lon:135.7850} : {lat:35.0262,lon:135.7808},
    excluded: Array.isArray(savedExcluded) ? savedExcluded.filter(x => typeof x === 'string').slice(-200) : [],
    clarify:null, route:null, index:0, position:null, follow:true, walk:null, lastWalk:null,
    // recordTrack：「歩いた道と記録を保存する」は最初からオン。保存したくない人が外す
    recordTrack:true, trackNotice:'', progressAlong:0, trail:[], showPast: storage.get('showPast', false) === true, restartPosition:null, originNote:'', saveNotice:'', error:'', geoMessage:'', blocked:'', historyBack:'mood' };
  let controller = null, timer = null, watch = null, map = null, overlays = [], userMarker = null, accuracyCircle = null, originMarker = null,
    routeBounds = null, passedLine = null, remainLine = null, trailLine = null, pastLines = [], geoCache = {route:null, origin:null, value:null}, mapPromise = null, configChecked = false, requestToken = 0, mapsAuthError = false;

  const ACTIVE_TTL_MS = 12 * 60 * 60 * 1000; // loadActive() より前に置く（後ろだと起動時に参照できず、保存が消える）
  const pendingWalk = loadActive();
  if (pendingWalk) state.screen = 'resume';

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
  function clearMap() { for (const o of overlays) o.setMap(null); overlays=[]; userMarker=null; accuracyCircle=null; originMarker=null; routeBounds=null; passedLine=null; remainLine=null; trailLine=null; pastLines=[]; if(map) google.maps.event.clearInstanceListeners(map); map=null; }
  function go(screen) { state.screen = screen; state.error=''; render(); app.focus({preventScroll:true}); }
  function mapMarkup(extraClass='') { return `<div id="map" class="map ${extraClass}" aria-label="地図"></div><p id="map-label" class="map-label" hidden></p>`; }
  function setMapLabel(text) { const el=$('#map-label'); if(el){el.textContent=text;el.hidden=!text;} }

  // ---- 歩いている途中の散歩（画面を閉じても続きから歩けるように） ----
  // ルートと進み具合をこのブラウザに一時保存する。Google由来の内容を長く残さないよう、12時間で破棄し、maps_uri は保存しない。
  function saveActive() {
    if (!state.walk || !state.route || !['walk','reflect'].includes(state.screen)) return;
    const r = state.route;
    storage.set('active', { v:1, saved_at:Date.now(), screen:state.screen, mock,
      mood:state.mood, preference:state.preference, crowd:state.crowd, minutes:state.minutes, origin:state.origin,
      index:state.index, recordTrack:state.recordTrack, walk:state.walk,
      route:{ interpretation:r.interpretation, polyline:r.polyline, total_minutes:r.total_minutes,
        attributions:r.attributions, sources:r.sources,
        places:r.places.map(({id,place_id,name,kind,lat,lon,hint,warning})=>({id,place_id,name,kind,lat,lon,hint,warning})) } });
  }
  function loadActive() {
    const a = storage.get('active', null);
    try {
      if (!a || a.v !== 1 || a.mock !== mock || !Number.isFinite(a.saved_at) || Date.now() - a.saved_at > ACTIVE_TTL_MS) throw 0;
      validateRoute(a.route);
      if (!Number.isInteger(a.index) || a.index < 0 || a.index >= a.route.places.length || !a.walk || typeof a.walk.id !== 'string' || !validPoint(a.origin)) throw 0;
      return a;
    } catch { if (a) storage.remove('active'); return null; }
  }
  function clearActive() { storage.remove('active'); }

  // ---- 歩いた記録 ----
  function loadWalks() { return normalizeWalks(storage.get('walks', [])); }
  function saveWalk(w) { return storage.set('walks', [...loadWalks().filter(x => x.id !== w.id), w].slice(-MAX_WALKS)); }
  function startWalkRecord() {
    state.walk = { id:newId(), started_at:new Date().toISOString(), ended_at:null, mood:state.mood, preference:state.preference,
      crowd:state.crowd, minutes:state.minutes, mock, places:[], save:state.recordTrack };
    tracker.start(state.walk.id,{enabled:state.recordTrack,mock});
  }
  function recordVisit(p, comment) {
    const w = state.walk; if (!w) return;
    const entry = { id:p.id, place_id:typeof p.place_id==='string'?p.place_id:null, name:p.name, kind:typeof p.kind==='string'?p.kind:'',
      lat:p.lat, lon:p.lon, visited_at:new Date().toISOString(), comment:comment.slice(0, MAX_COMMENT) };
    w.places = [...w.places.filter(x => x.id !== p.id), entry];
    // 「歩いた道と記録を保存する」を選んだときだけ保存する。選ばないときは、この散歩の間だけ覚えておく
    if (keepRecord(w)) saveWalk(w); // 途中で画面を閉じても、着いた場所までは残る
    saveActive();
  }
  function keepRecord(w) { return (w?.save ?? state.recordTrack) === true; }
  function finishWalk(reason='completed') {
    clearActive();
    tracker.finish(reason);
    const w = state.walk; state.walk = null; state.lastWalk = w;
    state.saveNotice = tracker.status().error || '';
    if (w) {
      w.ended_at = new Date().toISOString(); w.status = reason;
      w.elapsed_seconds = Math.max(0, Math.round((Date.parse(w.ended_at)-Date.parse(w.started_at))/1000));
      // 未訪問でも、ここまで歩いた1回の散歩として保存。未到着の場所は追加しない。保存を選ばなかった散歩は残さない。
      if (keepRecord(w) && !saveWalk(w)) state.saveNotice = '散歩の記録を保存できませんでした。ブラウザの容量や保存設定を確認してください。';
    }
  }
  function requestWalkEnd() {
    if (!state.walk) return;
    const draft = state.screen === 'reflect' && $('#comment')?.value.trim();
    const message = (keepRecord(state.walk) ? 'ここまでの記録を残して終了しますか？' : '散歩を終了しますか？\n保存しない設定なので、この散歩の記録は残りません。') + (draft ? '\n入力途中のメモは保存されません。残す場合はキャンセルして先に記録してください。' : '');
    if (!confirm(message)) return;
    state.restartPosition = state.position && !state.position.simulated && validPoint(state.position) ? {...state.position} : null;
    stopWatch(); finishWalk('stopped'); go('restart-choice');
  }
  function resetNewWalk(origin=state.origin, note='') {
    // 前の散歩の気分・予定時間・ルートは引き継がない。履歴と除外記録は消さない。
    requestToken++; controller?.abort(); stopWatch(); clearActive();
    Object.assign(state,{mood:'',preference:'',crowd:'neutral',minutes:45,clarify:null,route:null,index:0,position:null,
      follow:true,walk:null,lastWalk:null,recordTrack:true,geoMessage:'',restartPosition:null,origin:{...origin},originNote:note,saveNotice:''});
    go('mood');
  }
  async function restartFromHere() {
    const last = state.restartPosition;
    if (last && Math.abs(Date.now()-last.timestamp)<=30000) {
      resetNewWalk(last,'直前の現在地を出発地の初期値にしました。時間と出発地は散歩の準備画面で選び直せます。'); return;
    }
    const start=$('#restart-walk'); if(start)start.disabled=true;
    const status=$('#restart-status'); if(status)status.textContent='現在地を確認しています…';
    try {
      const origin = await new Promise((resolve,reject)=>{
        if(!navigator.geolocation || !window.isSecureContext){reject(new Error('位置情報を取得できません'));return;}
        navigator.geolocation.getCurrentPosition(p=>resolve({lat:p.coords.latitude,lon:p.coords.longitude}),reject,
          {enableHighAccuracy:true,timeout:12000,maximumAge:0});
      });
      if(state.screen!=='restart-choice')return;
      if(!validPoint(origin))throw new Error('位置情報を取得できません');
      resetNewWalk(origin,'現在地を出発地の初期値にしました。これから歩く時間を選び直してください。');
    } catch {
      if(state.screen!=='restart-choice')return;
      resetNewWalk(last ?? state.origin,'現在地を確認できませんでした。散歩の準備画面で出発地を確認・変更してください。');
    }
  }

  const brand = document.querySelector('.brand');
  if(brand) {
    brand.setAttribute('href',mock?'./?mock=1':'./');
    brand.addEventListener('click',e=>{
      if(e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)return;
      e.preventDefault();
      if(state.walk){requestWalkEnd();return;}
      if(state.screen==='restart-choice')return; // 終了後の選択を飛ばさない。
      requestToken++;controller?.abort();go(storage.get('notice',false)?'mood':'notice');
    });
  }


  function render() {
    clearInterval(timer); clearMap(); app.removeAttribute('aria-busy');
    const s = state.screen;
    if (s === 'notice') {
      app.innerHTML = `${progress(0)}<h2>歩く前に、<br>小さな約束を。</h2><ul class="notice-list"><li><b>画面を見るときは、立ち止まる。</b><p>歩いている間は、街の景色を楽しんでください。</p></li><li><b>入れる場所か、その場で確かめる。</b><p>営業時間や立入制限は変わります。看板・現地の案内を優先してください。</p></li><li><b>気が進まなければ、引き返す。</b><p>暗い道や不安な場所を避け、無理のない散歩を。</p></li></ul>${button('accept','わかりました、はじめる')}<p class="subtle">歩いている間の現在地はブラウザの中で処理し、自分たちのサーバーには送りません。出発地のみ、ルート作成時にサーバーへ送ります。「歩いた道と記録を保存する」を選んだ散歩だけ、歩いた道・立ち寄った場所・メモをこのブラウザに保存します。</p>`;
      event('#accept','click',()=>{storage.set('notice',true);go('mood');});
    } else if (s === 'mood') {
      const walks = loadWalks();
      app.innerHTML = `${progress(1)}<h2>今日は、<br>どんな気分ですか。</h2><p class="lead">うまく言葉にならなくても、大丈夫。<br>いま思い浮かんだ、一言から。</p>${state.originNote?`<p class="subtle" role="status">${esc(state.originNote)}</p>`:''}<form id="mood-form"><label for="mood" class="field">いまの気分</label><textarea id="mood" class="text-field" maxlength="200" required placeholder="「ワクワクを感じたい」「寂しい」「エモい」など、あなたの気持ちをそのまま入力してください。">${esc(state.mood)}</textarea>${errorBox()}<button class="primary" type="submit">気分をほどく</button></form><div class="home-links">${button('trackmap','歩いた道の地図','secondary')}${walks.length||loadTracks().length?button('history',`歩いた記録（${walks.length}回）`,'secondary'):''}</div>`;
      event('#mood-form','submit',async e=>{e.preventDefault();state.mood=$('#mood').value.trim();if(!state.mood)return setError('いまの気分を一言入力してください。');await request('clarify',{mood:state.mood},'choices','mood');});
      event('#history','click',()=>{state.historyBack='mood';go('history');});
      event('#trackmap','click',()=>{state.trackmapBack='mood';go('trackmap');});
    } else if (s === 'choices') {
      app.innerHTML = `${progress(2)}<span class="pill">${esc(state.mood)}</span><h2>${esc(state.clarify.question)}</h2><p class="lead">いまの自分に近いものを、ひとつ。</p><div>${state.clarify.options.map((o,i)=>`<button type="button" class="choice" data-option="${i}">${esc(o.label)}</button>`).join('')}</div><div class="divider">自分の言葉でも</div><form id="preference-form"><label class="field" for="preference">もう少し伝える</label><input id="preference" class="text-field" maxlength="200" placeholder="どんなふうに過ごしたい？" value="${esc(state.preference)}"><label class="field" for="crowd">人の多さは？</label><select id="crowd" class="text-field"><option value="neutral">どちらでも</option><option value="avoid">混雑を避けたい</option><option value="ok">にぎやかでいい</option></select>${errorBox()}<button type="submit" class="primary">この気分で歩く</button></form><div class="actions">${button('back','戻る','text-button')}${button('surprise','おまかせ','text-button')}</div>`;
      app.querySelectorAll('[data-option]').forEach(b=>b.addEventListener('click',()=>{const o=state.clarify.options[Number(b.dataset.option)];state.preference=o.label;state.crowd=o.crowd;go('setup');}));
      event('#preference-form','submit',e=>{e.preventDefault();state.preference=$('#preference').value.trim();if(!state.preference)return setError('気分を入力するか、選択肢・おまかせを選んでください。');state.crowd=$('#crowd').value;go('setup');});
      event('#surprise','click',()=>{state.preference=state.mood;state.crowd='neutral';go('setup');});event('#back','click',()=>go('mood'));
    } else if (s === 'setup') {
      app.innerHTML = `${progress(3)}<h2>どこから、<br>どのくらい歩こう。</h2><p class="lead">${esc(state.preference)}</p><form id="setup-form"><fieldset style="border:0;padding:0;margin:0"><legend class="field">散歩の時間</legend><div class="duration-options">${[30,45,60].map(n=>`<label class="duration-option"><input type="radio" name="minutes" value="${n}" ${state.minutes===n?'checked':''}><span>${n}分</span></label>`).join('')}</div></fieldset><label class="field">出発地</label>${button('locate','◎ 現在地を使う','secondary')}<p id="geo-status" class="subtle" role="status">${mock?'':'「現在地を使う」を押すと、今いる場所から歩けます。'}</p>${mapMarkup()}${errorBox()}<button class="primary" type="submit">ルートをつくる</button></form>${button('back','気分の選択に戻る','text-button')}${state.excluded.length?button('clear-excluded','外した場所の記録をリセット','text-button'):''}`;
      event('#locate','click',locate);event('#back','click',()=>go('choices'));
      event('#clear-excluded','click',()=>{state.excluded=[];storage.set('excluded',[]);go('setup');});
      event('#setup-form','submit',async e=>{e.preventDefault();state.minutes=Number(new FormData(e.target).get('minutes'));if(!validPoint(state.origin))return setError('出発地を確認できませんでした。「現在地を使う」を押してください。');await createRoute('setup');});
      setupMap().catch(e=>setError(e.message));
    } else if (s === 'loading') {
      app.setAttribute('aria-busy','true');app.innerHTML=`${progress(state.pending==='clarify'?1:3)}<div class="waiting"><div class="loader" aria-hidden="true"></div><p class="waiting-word">「${esc(state.mood)}」</p><h2>${state.pending==='clarify'?'この言葉を、<br>ほどいています。':'この言葉から、<br>近所を探しています。'}</h2><p id="waiting-text" class="lead" role="status">${mock?'見本データを読み込んでいます。':'少しだけ、お待ちください。'}</p><p class="subtle">${mock?'このモードではAI・場所検索・ルートのAPIを呼びません。':'通常10〜40秒ほど。混雑時は長くかかることがあります。'}</p>${button('cancel','キャンセル','text-button')}</div>`;
      const start=Date.now();timer=setInterval(()=>{const t=Math.floor((Date.now()-start)/1000);if(t>=10)$('#waiting-text').textContent=t>=40?'時間がかかっています。キャンセルしてやり直すこともできます。':'まだ処理中です。もう少しお待ちください。';},1000);
      event('#cancel','click',()=>{requestToken++;controller?.abort();go(state.returnScreen);});
    } else if (s === 'route') {
      // 歩く時間だけの目安。下の一覧に出す区間ごとの「徒歩 約○分」の合計と同じ数字にする
      const walkMinutes=state.route.places.reduce((sum,p,i)=>sum+routeLeg(i).minutes,0);
      app.innerHTML=`<div class="route-head"><h2 class="route-title">「${esc(state.mood)}」を、歩く。</h2><p class="route-meta"><span>${state.route.places.length}か所</span><span>徒歩 約<strong>${esc(walkMinutes)}</strong>分</span><span>滞在を除く</span></p></div>${mapMarkup('route-map')}${attribution()}${state.route.interpretation?`<p class="route-interpretation">${esc(state.route.interpretation)}</p>`:''}<div id="route-details" ${mock?'':'hidden'}><ol class="trail"><li class="trail-start"><span class="trail-dot" aria-hidden="true"></span><b>出発地</b></li>${state.route.places.map((p,i)=>{const leg=routeLeg(i);return `<li class="trail-leg">徒歩 約${leg.minutes}分（${leg.road?'道のり ':'約'}${formatDistance(leg.meters)}）</li><li class="trail-stop"><span class="trail-dot" aria-hidden="true">${i+1}</span><div class="trail-body"><span class="place-kind">${esc(p.kind)}</span><h3>${esc(p.name)}</h3><p>${esc(p.hint)}</p>${p.warning?`<p class="warning">${esc(p.warning)}</p>`:''}${link(p.maps_uri,'Google Mapsで見る')}</div><button type="button" class="remove" data-remove="${i}" aria-label="${esc(p.name)}を外す">外す</button></li>`;}).join('')}</ol><div class="sources">${(state.route.sources||[]).map(x=>link(x.uri,x.title)).join(' ')}</div></div>${errorBox()}<label class="check"><input id="save-track" type="checkbox" ${state.recordTrack?'checked':''}><span>歩いた道と記録をこのブラウザに保存する</span></label><p class="subtle">歩いた道と立ち寄った場所・メモを保存し、あとで地図で見返せます。外すと何も残りません。</p><button id="start" type="button" class="primary go" ${mock?'':'disabled'}>歩きはじめる</button><p class="subtle">時間は、滞在を除いた歩く時間の目安です。</p>${button('back','時間・出発地を変更する','text-button')}`;
      event('#start','click',()=>{state.recordTrack=$('#save-track').checked;state.index=0;state.position=null;state.geoMessage='';state.follow=true;state.progressAlong=0;state.trail=[];startWalkRecord();go('walk');saveActive();startWatch();});event('#back','click',()=>go('setup'));
      app.querySelectorAll('[data-remove]').forEach(b=>b.addEventListener('click',async()=>{const id=state.route.places[Number(b.dataset.remove)].id;state.excluded=[...new Set([...state.excluded,id])].slice(-200);storage.set('excluded',state.excluded);await createRoute('route');}));
      resultMap().then(()=>{if(state.screen==='route'&&!mapsAuthError){$('#route-details').hidden=false;$('#start').disabled=false;}}).catch(e=>setError(e.message));
    } else if (s === 'walk') {
      const p=state.route.places[state.index];
      app.innerHTML=`<div class="walk-screen"><div class="walk-map-wrap"><div id="map" class="map walk-map" aria-label="地図"></div><div class="map-notes">${attribution()}<p id="map-label" class="map-label" hidden></p></div><div id="map-tools" class="map-tools" hidden>${button('recenter','◎ 現在地に戻る','map-button')}${button('overview','ルート全体','map-button')}<button id="past-tracks" class="map-button" type="button" aria-pressed="${state.showPast}" hidden>過去の道</button></div></div><section class="sheet" aria-label="次の場所"><span class="sheet-handle" aria-hidden="true"></span><p class="sheet-step">${state.index+1} / ${state.route.places.length} か所目</p><p id="walk-distance" class="walk-distance"></p><p id="walk-direction" class="walk-direction"></p><div id="walk-details" class="next-place" ${mock?'':'hidden'}><h3>${esc(p.name)}</h3><p>${esc(p.hint)}</p>${p.warning?`<p class="warning">${esc(p.warning)}</p>`:''}</div><p id="geo-status" class="geo-status" role="status"></p><p id="track-status" class="subtle" role="status"></p>${button('stop-track','歩いた道の保存を停止','text-button')}${errorBox()}<div class="sheet-action">${button('arrive','着いた','primary')}</div>${mock?`<div class="mock-tools"><p>見本モードの操作確認</p>${button('simulate','この場所への到着を再現','secondary')}</div>`:''}<div class="sheet-links">${button('stop','散歩を切り上げる','text-button')}</div></section></div>`;
      resultMap().then(()=>{if(state.screen==='walk'&&!mapsAuthError)$('#walk-details').hidden=false;}).catch(e=>setError(e.message));
      updateWalk();event('#arrive','click',arrive);event('#simulate','click',()=>{const pos={...p,accuracy:10,timestamp:Date.now(),simulated:true};receivePosition(pos);});event('#stop','click',requestWalkEnd);
      event('#stop-track','click',()=>tracker.finish('stopped'));
      event('#recenter','click',()=>{state.follow=true;if(state.position){map?.panTo({lat:state.position.lat,lng:state.position.lon});map?.setZoom(17);}else startWatch();});
      event('#overview','click',()=>{state.follow=false;if(map&&routeBounds)map.fitBounds(routeBounds,35);});
      event('#past-tracks','click',e=>{state.showPast=!state.showPast;storage.set('showPast',state.showPast);e.currentTarget.setAttribute('aria-pressed',String(state.showPast));drawPastTracks();});
    } else if (s === 'reflect') {
      const p=state.route.places[state.index], last=state.index+1>=state.route.places.length;
      app.innerHTML=`${progress(4)}<p class="sheet-step">${state.index+1} / ${state.route.places.length} か所目　${esc(p.name)}</p><h2 class="question">求めていた<br>「${esc(state.mood)}」は、<br>感じられた？</h2><form id="reflect-form">${keepRecord(state.walk)?`<label for="comment" class="field">ひとことメモ</label><textarea id="comment" class="notebook" maxlength="${MAX_COMMENT}" placeholder="書かなくても大丈夫。たとえば、思ったより静かだった。"></textarea><p class="subtle">立ち寄った場所とメモは「歩いた記録」としてこのブラウザに保存されます。</p>`:''}<button class="primary${last?'':' go'}" type="submit">${keepRecord(state.walk)?(last?'記録して散歩を終える':'記録して次へ歩く'):(last?'散歩を終える':'次へ歩く')}</button></form>${button('not-yet','まだ着いていない','text-button')}`;
      event('#reflect-form','submit',e=>{e.preventDefault();recordVisit(p,$('#comment')?.value.trim()??'');nextPlace();});
      event('#not-yet','click',()=>{state.follow=true;go('walk');saveActive();startWatch();});
    } else if (s === 'resume') {
      const a = pendingWalk, n = a.route.places.length, next = a.route.places[a.index];
      app.innerHTML=`${progress(4)}<h2>歩いている途中の、<br>よりみちがあります。</h2><p class="lead">「${esc(a.mood)}」　${a.index+1} / ${n} か所目</p><p class="subtle">次の場所：${esc(next.name)}</p>${button('resume-walk','続きから歩く','primary go')}${button('resume-end','この散歩を終える','secondary wide')}`;
      event('#resume-walk','click',()=>{
        Object.assign(state,{mood:a.mood,preference:a.preference,crowd:a.crowd,minutes:a.minutes,origin:a.origin,index:a.index,
          recordTrack:a.recordTrack,route:a.route,walk:a.walk,position:null,geoMessage:'',follow:true,progressAlong:0,trail:[]});
        // 位置履歴は同じIDで上書きしないよう、新しい区切りとして始める
        if (a.recordTrack) tracker.start(`${a.walk.id}~${Date.now().toString(36)}`,{enabled:true,mock});
        if (a.screen === 'reflect') { go('reflect'); saveActive(); } else { go('walk'); saveActive(); startWatch(); }
      });
      event('#resume-end','click',()=>{
        Object.assign(state,{route:a.route,walk:a.walk,mood:a.mood});
        finishWalk('interrupted'); go('done');
      });
    } else if (s === 'restart-choice') {
      const n=state.lastWalk?.places.length??0, minutes=Math.round((state.lastWalk?.elapsed_seconds??0)/60);
      app.innerHTML=`${progress(4)}<h2>ここまでの、よりみち。</h2><p class="lead">散歩を終了し、位置追跡を停止しました。</p><p class="subtle">約${minutes}分歩き、${n}か所に立ち寄りました。</p>${state.saveNotice?`<p class="error" role="alert">${esc(state.saveNotice)} 保存できていない記録は、この画面を閉じると失われる場合があります。</p>`:''}${button('restart-walk','現在地から新しく歩く')}${button('finish-today','今日は終える','secondary wide')}<p id="restart-status" class="subtle" role="status"></p><p class="subtle">気分の入力から、新しく始められます。</p>`;
      event('#restart-walk','click',restartFromHere);
      event('#finish-today','click',()=>go('done'));
    } else if (s === 'done') {
      const n=state.lastWalk?.places.length??0;
      app.innerHTML=`${progress(4)}<div class="finish-mark" aria-hidden="true">↗</div><h2>おつかれさまでした。</h2><p class="lead">いつもの街に、<br>少しだけ違う景色が増えたなら。</p>${state.lastWalk?`<p class="subtle">今回は約${Math.round((state.lastWalk.elapsed_seconds??0)/60)}分・${n}か所に立ち寄りました。</p>`:''}${state.saveNotice?`<p class="error" role="alert">${esc(state.saveNotice)}</p>`:''}${button('again','また、よりみちする')}${button('history','歩いた記録を見る','secondary wide')}${button('trackmap','歩いた道の地図を見る','secondary wide')}${button('erase','このブラウザの歩いた記録・外した場所を消す','text-button')}<p id="erase-status" class="subtle" role="status"></p>`;
      event('#again','click',()=>resetNewWalk());
      event('#history','click',()=>{state.historyBack='done';go('history');});
      event('#trackmap','click',()=>{state.trackmapBack='done';go('trackmap');});
      event('#erase','click',()=>{if(!confirm('歩いた記録・歩いた道の履歴・外した場所の記録を消します。元に戻せません。よろしいですか？'))return;storage.remove('walks');storage.remove('ratings');tracker.clearAll();storage.set('excluded',[]);state.excluded=[];$('#erase-status').textContent=tracker.status().error||'歩いた記録・歩いた道の履歴・外した場所の記録を消しました。';});
    } else if (s === 'history') {
      const walks=loadWalks().reverse(), count=walks.reduce((a,w)=>a+w.places.length,0), days=[];
      for(const w of walks){const day=dayText(w.started_at),g=days[days.length-1];if(g&&g.day===day)g.walks.push(w);else days.push({day,walks:[w]});}
      app.innerHTML=`<h2 class="diary-title">歩いた記録</h2><p class="lead">${walks.length?`${walks.length}回の散歩で、${count}か所に立ち寄りました。このブラウザにだけ保存されています。`:'まだ記録はありません。散歩で場所に着くと、ここに残ります。'}</p>${days.map(g=>`<section class="diary-day"><h3 class="diary-date">${esc(g.day)}</h3><ol class="walk-log">${g.walks.map(w=>`<li><p class="walk-log-head"><time datetime="${esc(w.started_at)}">${esc(timeText(w.started_at))}</time>${w.mock?'<span class="badge">見本</span>':''}</p>${w.status==='stopped'?'<p class="subtle">途中で終了</p>':''}${w.elapsed_seconds!==null?`<p class="subtle">実際の散歩時間：約${Math.round(w.elapsed_seconds/60)}分</p>`:''}<p class="walk-log-mood">「${esc(w.mood)}」</p>${w.preference&&w.preference!==w.mood?`<p class="walk-log-pref">${esc(w.preference)}</p>`:''}<ul class="visit-list">${w.places.map(p=>`<li><span class="place-kind">${esc(p.kind)}</span><b>${esc(p.name)}</b>${p.comment?`<p class="note">${esc(p.comment)}</p>`:''}</li>`).join('')}</ul></li>`).join('')}</ol></section>`).join('')}${trackHistoryMarkup()}${button('trackmap','歩いた道を地図で見る','secondary wide')}${button('back','戻る','secondary wide')}${walks.length?button('erase-walks','歩いた記録をすべて消す','text-button'):''}`;
      event('#back','click',()=>go(state.historyBack));
      event('#trackmap','click',()=>{state.trackmapBack='history';go('trackmap');});
      event('#erase-tracks','click',()=>{if(!confirm('保存した歩いた道の履歴をすべて削除しますか？元に戻せません。'))return;tracker.clearAll();go('history');if(tracker.status().error)setError(tracker.status().error);});
      event('#erase-walks','click',()=>{if(!confirm('歩いた記録をすべて消します。元に戻せません。よろしいですか？'))return;storage.remove('walks');go('history');});
    } else if (s === 'trackmap') {
      const tracks=loadTracks().filter(t=>t.mock===mock&&t.points.length>=2);
      const total=tracks.reduce((n,t)=>n+t.points.slice(1).reduce((m,p,i)=>m+trackDistance(t.points[i],p),0),0);
      app.innerHTML=`<div class="route-head"><h2 class="route-title">歩いた道</h2><p class="route-meta"><span>${tracks.length}回分</span><span>合計 約<strong>${esc((total/1000).toFixed(1))}</strong>km</span></p></div>${mapMarkup('route-map')}${attribution()}${tracks.length?'<ul class="legend" aria-label="線と印の意味"><li><span class="legend-line latest" aria-hidden="true"></span>一番新しい道</li><li><span class="legend-line" aria-hidden="true"></span>それより前の道</li><li><span class="legend-dot" aria-hidden="true"></span>立ち寄った場所</li></ul>':''}<p class="subtle">保存した道を、7日間表示します。</p>${tracks.length?'':'<p class="lead">まだ表示できる道がありません。ルート画面で「歩いた道と記録を保存する」を選んで歩くと、ここに重なっていきます。</p>'}${button('back','戻る','secondary wide')}`;
      event('#back','click',()=>go(state.trackmapBack||'mood'));
      trackMap(tracks).catch(e=>setError(e.message));
    } else if(s === 'blocked') {
      stopWatch();app.innerHTML=`<div class="blocked"><p role="alert">${esc(state.blocked)}</p></div>`;
    }
  }
  function loadTracks() {
    try { return trackStore.list(); } catch(e) { state.trackNotice=e.message;return []; }
  }
  function updateTrackStatus() {
    const info=tracker.status(),el=$('#track-status'),stop=$('#stop-track');
    if(el)el.textContent=info.error?`歩いた道を記録できませんでした。${info.error}`:info.active?'歩いた道を記録中':info.status==='limit'?'記録の上限に達したため、記録を止めました。':info.status==='stopped'?'歩いた道の記録を止めました。':'';
    if(el)el.hidden=!el.textContent; // 保存しないときは何も表示しない
    if(stop)stop.hidden=!info.active;
  }
  function trackHistoryMarkup() {
    const tracks=loadTracks().reverse();
    const items=tracks.map(t=>{
      const length=t.points.slice(1).reduce((n,p,i)=>n+trackDistance(t.points[i],p),0);
      return `<li><time>${esc(dateText(new Date(t.started_at).toISOString()))}</time> ${t.mock?'（見本）':''}<p>約${esc(formatDistance(length))}歩きました</p></li>`;
    }).join('');
    return `<section><h3>歩いた道の記録</h3><p class="subtle">このブラウザに7日間保存します。距離は目安です。</p>${state.trackNotice?`<p class="warning">${esc(state.trackNotice)}</p>`:''}${tracks.length?`<ul>${items}</ul>${button('erase-tracks','履歴をすべて削除する','text-button')}`:'<p class="subtle">履歴はまだありません。</p>'}</section>`;
  }

  function formatDistance(m) { return m>=1000?`${(m/1000).toFixed(1)} km`:`${Math.round(m)} m`; }
  function routeBody() { return {mood:state.mood,preference:state.preference,crowd:state.crowd,lat:state.origin.lat,lon:state.origin.lon,minutes:state.minutes,exclude_ids:excludeIds(state.excluded,[]),include_ids:[]}; }
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

  }
  async function resultMap() {
    const screen=state.screen,container=$('#map');const kind=await prepareMap();if(state.screen!==screen||$('#map')!==container)return;
    if(kind==='mock'){mockMap();return;}
    map=newMap(container,{lat:state.origin.lat,lng:state.origin.lon});
    const bounds=new google.maps.LatLngBounds();const start={lat:state.origin.lat,lng:state.origin.lon};bounds.extend(start);
    const path=google.maps.geometry.encoding.decodePath(state.route.polyline);
    if(path.length<2)throw new Error('歩く道の線を読み取れませんでした。もう一度ルートを作ってください。');
    path.forEach(p=>bounds.extend(p));
    if(screen==='walk'&&geo()){
      // 歩行中：ルートのうち通ったところは薄い色、これからの道は緑。自分が実際に歩いた線は青で重ねる
      passedLine=new google.maps.Polyline({map,path:[],strokeColor:'#9aa596',strokeWeight:6,strokeOpacity:.85,zIndex:1});
      remainLine=new google.maps.Polyline({map,path:[],strokeColor:'#294d3c',strokeWeight:5,strokeOpacity:.95,zIndex:2});
      trailLine=new google.maps.Polyline({map,path:[],strokeColor:'#3978c2',strokeWeight:4,strokeOpacity:.75,zIndex:3});
      overlays.push(passedLine,remainLine,trailLine);updateRouteProgress();
    } else overlays.push(new google.maps.Polyline({map,path,strokeColor:'#294d3c',strokeWeight:5,strokeOpacity:.9}));
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
    const pastButton=$('#past-tracks');if(pastButton)pastButton.hidden=!pastTracks().length; // 保存した道がないときはボタンを出さない
    drawPastTracks();
    if(state.position)updateUserMarker(false);
  }
  // ---- 道のり・通ったところ ----
  function geo() {
    if(geoCache.route!==state.route||geoCache.origin!==state.origin)geoCache={route:state.route,origin:state.origin,value:state.route?routeGeometry(state.route,state.origin):null};
    return geoCache.value;
  }
  // i番目の場所までの区間。線に沿った距離が取れないとき（線の形が不正、場所が道から遠いなど）は、直線×1.3で代わりに出す
  function routeLeg(i) {
    const prev=i?state.route.places[i-1]:state.origin,p=state.route.places[i],straight=distanceMeters(prev,p),g=geo();
    if(g){const a=i?g.places[i-1]:g.origin,b=g.places[i],d=b.along-a.along;
      if(a.offset<=80&&b.offset<=80&&d>=straight*.9)return {meters:d,minutes:Math.max(1,Math.round(d/70)),road:true};}
    return {meters:straight*1.3,minutes:legMinutes(prev,p),road:false};
  }
  // 次の場所までの残り。現在地（なければ1つ前の場所か出発地）をルートの線に重ねて測る
  function remainingToNext() {
    const i=state.index,p=state.route.places[i],base=state.position||(i?state.route.places[i-1]:state.origin),straight=distanceMeters(base,p),g=geo();
    if(g){const from=i?g.places[i-1].seg:g.origin.seg,target=g.places[i],here=locateOnPath(g.pts,g.cum,base,from,target.seg),d=target.along-here.along;
      if(here.offset<=60&&target.offset<=80&&d>=0&&d>=straight*.9)return {meters:d,road:true,along:here.along,base};}
    return {meters:straight,road:false,base};
  }
  function updateRouteProgress() {
    const g=geo();if(!g)return;
    const reached=state.index?g.places[state.index-1].along:g.origin.along; // 着いた場所までは通ったことにする
    state.progressAlong=Math.max(state.progressAlong||0,reached);
    const ll=pts=>pts.map(p=>({lat:p.lat,lng:p.lon}));
    if(passedLine&&remainLine){const [done,rest]=splitPath(g.pts,g.cum,state.progressAlong);passedLine.setPath(ll(done));remainLine.setPath(ll(rest));}
    if(trailLine)trailLine.setPath(ll(state.trail||[]));
  }
  // 保存した過去の道（今歩いている散歩の分は除く）
  function pastTracks() {
    const current=state.walk?.id;
    return loadTracks().filter(t=>t.mock===mock&&t.points.length>=2&&!(current&&t.id.startsWith(current)));
  }
  // 歩行中の地図に、過去の道をうっすら重ねる。ボタンでオン・オフ
  function drawPastTracks() {
    for(const l of pastLines)l.setMap(null);pastLines=[];
    if(!map||!state.showPast||state.screen!=='walk'||!window.google?.maps)return;
    for(const t of pastTracks()){
      const line=new google.maps.Polyline({map,path:t.points.map(p=>({lat:p.lat,lng:p.lon})),strokeColor:'#7d8f80',strokeWeight:4,strokeOpacity:.35,zIndex:0,clickable:false});
      pastLines.push(line);overlays.push(line);
    }
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

  // ---- 歩いた道の地図 ----
  async function trackMap(tracks) {
    const container=$('#map');const kind=await prepareMap();if(state.screen!=='trackmap'||$('#map')!==container)return;
    const visited=loadWalks().filter(w=>w.mock===mock).flatMap(w=>w.places);
    if(kind==='mock'){trackSvg(container,tracks,visited);return;}
    map=newMap(container,{lat:state.origin.lat,lng:state.origin.lon},14);
    const bounds=new google.maps.LatLngBounds();let any=false;
    tracks.forEach((t,i)=>{
      const path=t.points.map(p=>({lat:p.lat,lng:p.lon}));path.forEach(p=>{bounds.extend(p);any=true;});
      const latest=i===tracks.length-1;
      overlays.push(new google.maps.Polyline({map,path,strokeColor:latest?'#294d3c':'#5f8a6f',strokeWeight:latest?5:4,strokeOpacity:latest?.95:.6}));
    });
    visited.forEach(p=>{const position={lat:p.lat,lng:p.lon};bounds.extend(position);any=true;
      overlays.push(new google.maps.Marker({map,position,title:p.name,icon:{path:google.maps.SymbolPath.CIRCLE,scale:5,fillColor:'#fffef9',fillOpacity:1,strokeColor:'#294d3c',strokeWeight:2}}));});
    if(any)map.fitBounds(bounds,35);
    setMapLabel('');
  }
  // キーがない見本モード用：記録した道を簡単な図で描く
  function trackSvg(el,tracks,visited) {
    el.classList.add('mock-map');
    const all=[...tracks.flatMap(t=>t.points),...visited];
    if(!all.length){el.innerHTML='<svg viewBox="0 0 440 250" role="img" aria-label="まだ道はありません"><rect class="mock-ground" width="440" height="250"/></svg>';setMapLabel('');return;}
    const lats=all.map(p=>p.lat),lons=all.map(p=>p.lon),minLat=Math.min(...lats),maxLat=Math.max(...lats),minLon=Math.min(...lons),maxLon=Math.max(...lons);
    const kx=Math.cos(minLat*Math.PI/180),w=Math.max((maxLon-minLon)*kx,1e-5),h=Math.max(maxLat-minLat,1e-5),scale=Math.min(400/w,210/h);
    const xy=p=>`${(20+((p.lon-minLon)*kx)*scale+(400-w*scale)/2).toFixed(1)},${(20+(maxLat-p.lat)*scale+(210-h*scale)/2).toFixed(1)}`;
    el.innerHTML=`<svg viewBox="0 0 440 250" role="img" aria-label="記録した道の図"><rect class="mock-ground" width="440" height="250"/>${tracks.map((t,i)=>`<polyline class="track-line${i===tracks.length-1?' latest':''}" points="${t.points.map(xy).join(' ')}"/>`).join('')}${visited.map(p=>{const [x,y]=xy(p).split(',');return `<circle class="track-visit" cx="${x}" cy="${y}" r="5"/>`;}).join('')}</svg>`;
    setMapLabel('キーがないため、地図の代わりに記録した道だけを図にしています。');
  }

  // ---- 位置情報 ----
  function geoErrorText(err) {
    if(!window.isSecureContext)return '現在地は https:// または localhost で開いたときだけ使えます。';
    if(err?.code===1)return '位置情報の利用が許可されていません。ブラウザと端末の設定で、このサイトの位置情報を許可してください。';
    if(err?.code===3)return '現在地の取得が時間切れになりました。屋外や窓の近くで、もう一度試してください。';
    return '現在地を取得できませんでした。';
  }
  function locate() {
    if(!navigator.geolocation)return setError('このブラウザでは現在地を取得できません。出発地は地図のピンの場所のままです。');
    if(!window.isSecureContext){$('#geo-status').textContent=geoErrorText();return;}
    const b=$('#locate');b.disabled=true;$('#geo-status').textContent='現在地を確認しています…';
    navigator.geolocation.getCurrentPosition(pos=>{
      if(state.screen!=='setup')return;b.disabled=false;
      state.origin={lat:pos.coords.latitude,lon:pos.coords.longitude};
      $('#geo-status').textContent=`現在地を出発地にしました。${mock?'見本モードでは、見本の場所は変わりません。':''}`;
      if(map&&originMarker){const p={lat:state.origin.lat,lng:state.origin.lon};originMarker.setPosition(p);map.panTo(p);map.setZoom(16);}
    },err=>{if(state.screen!=='setup')return;b.disabled=false;$('#geo-status').textContent=`${geoErrorText(err)} 出発地は地図のピンの場所のままです。`;},{enableHighAccuracy:true,timeout:12000,maximumAge:0});
  }
  function startWatch() {
    stopWatch();if(state.screen!=='walk')return;
    if(!navigator.geolocation||!window.isSecureContext){state.geoMessage=`${navigator.geolocation?geoErrorText():'このブラウザでは現在地を取得できません。'}「着いた」ボタンで進めます。`;updateWalk();return;}
    state.geoMessage='現在地を確認しています…';updateWalk();
    watch=navigator.geolocation.watchPosition(p=>receivePosition({lat:p.coords.latitude,lon:p.coords.longitude,accuracy:p.coords.accuracy,timestamp:p.timestamp}),err=>{state.geoMessage=`${geoErrorText(err)}「着いた」ボタンで進めます。`;updateWalk();},{enableHighAccuracy:true,timeout:15000,maximumAge:5000});
  }
  function receivePosition(p) {
    if(state.screen!=='walk'||!validPoint(p))return;tracker.record(p);state.position=p;
    // 自分が歩いた線（画面表示用。保存はしない）。精度50m以内、5m以上動いたときだけ足す
    if(!p.simulated&&p.accuracy<=50){const last=state.trail[state.trail.length-1];if(!last||distanceMeters(last,p)>=5)state.trail=[...state.trail,{lat:p.lat,lon:p.lon}].slice(-3000);}state.geoMessage=p.accuracy>50?'位置が不正確です。着いたら「着いた」を押してください。':'';
    if(isArrival(p,state.route.places[state.index])){arrive();return;}updateWalk();
  }
  function updateWalk() {
    if(state.screen!=='walk')return;updateTrackStatus();updateUserMarker();const p=state.route.places[state.index],from=state.position||state.origin;
    const r=remainingToNext();if(r.road&&state.position)state.progressAlong=Math.max(state.progressAlong||0,r.along);updateRouteProgress();
    $('#walk-distance').innerHTML=`${esc(formatDistance(r.meters).replace(/ (m|km)$/,''))}<small>${r.meters>=1000?'km':'m'}</small>`;
    $('#walk-direction').textContent=`${directionLabel(r.base,p)}の方角${r.road?'':'（直線距離）'}`;
    {const text=state.geoMessage||(state.position?'':'現在地を確認できていません。着いたら「着いた」を押してください。');$('#geo-status').textContent=text;$('#geo-status').hidden=!text;}
  }
  function arrive() {stopWatch();go('reflect');saveActive();}
  function nextPlace() {state.index++;state.geoMessage='';state.follow=true;if(state.index>=state.route.places.length){stopWatch();finishWalk();go('done');}else{go('walk');saveActive();startWatch();}}
  window.addEventListener('pagehide',()=>{saveActive();tracker.finish('interrupted');stopWatch();controller?.abort();clearInterval(timer);});
  render();
}
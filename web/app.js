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

if (typeof document !== 'undefined') boot();
function boot() {
  const app = document.querySelector('#app'), $ = s => app.querySelector(s), esc = escapeHTML;
  const mock = new URLSearchParams(location.search).get('mock') === '1';
  document.querySelector('#mode-badge').textContent = mock ? '見本モード' : '散歩をつくる';
  const storage = {
    get(k, fallback) { try { return JSON.parse(localStorage.getItem(`yorimichi:${k}`)) ?? fallback; } catch { return fallback; } },
    set(k, v) { try { localStorage.setItem(`yorimichi:${k}`, JSON.stringify(v)); } catch { /* 保存不可でも散歩を継続 */ } }
  };
  const savedExcluded = storage.get('excluded', []);
  const state = { screen: storage.get('notice', false) ? 'mood' : 'notice', mood: '', preference: '', crowd: 'neutral', minutes: 45,
    origin: {lat:34.9949,lon:135.7850}, excluded: Array.isArray(savedExcluded) ? savedExcluded.filter(x => typeof x === 'string').slice(-200) : [],
    clarify:null, route:null, index:0, position:null, error:'', geoMessage:'', blocked:'' };
  let controller = null, timer = null, watch = null, map = null, overlays = [], userMarker = null, mapPromise = null, requestToken = 0, mapsAuthError = false;
  const event = (selector, name, fn) => $(selector)?.addEventListener(name, fn);
  const progress = n => `<div class="step-top"><span class="step-label">${['BEFORE YOUR WALK','01 / 気分をほどく','02 / 気分を選ぶ','03 / 散歩の準備','YOUR LITTLE WALK'][n]}</span><span class="progress" aria-hidden="true">${[1,2,3].map(i=>`<i class="${i<=n?'active':''}"></i>`).join('')}</span></div>`;
  const errorBox = () => `<div id="error" class="error" role="alert" ${state.error?'':'hidden'}>${esc(state.error)}</div>`;
  const button = (id, text, cls='primary') => `<button id="${id}" class="${cls}" type="button">${text}</button>`;
  const link = (url, text) => safeURL(url) ? `<a href="${esc(safeURL(url))}" target="_blank" rel="noopener noreferrer">${esc(text)} ↗</a>` : '';
  const attribution = () => `<div class="attribution">${[...new Set(['© OpenStreetMap contributors', ...(Array.isArray(state.route?.attributions)?state.route.attributions:[])])].map(esc).join(' · ')} · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">ライセンス</a></div>`;
  function setError(text) { state.error = text; const el = $('#error'); if (el) { el.textContent = text; el.hidden = !text; } }
  function stopWatch() { if (watch !== null) navigator.geolocation?.clearWatch(watch); watch = null; }
  function clearMap() { for (const o of overlays) o.setMap(null); overlays=[]; userMarker=null; if(map) google.maps.event.clearInstanceListeners(map); map=null; }
  function go(screen) { state.screen = screen; state.error=''; render(); app.focus({preventScroll:true}); }
  function mapMarkup() { return `<div id="map" class="map ${mock?'mock-map':'google'}" aria-label="${mock?'操作確認用の模式図':'Googleマップ'}"></div>${mock?'<p class="map-label">見本の模式図です。道順・営業・立入可否は未確認です。</p>':''}`; }
  function render() {
    clearInterval(timer); clearMap(); app.removeAttribute('aria-busy');
    const s = state.screen;
    if (s === 'notice') {
      app.innerHTML = `${progress(0)}<span class="eyebrow">ひと息ついて、出かけよう。</span><h2>歩く前に、<br>小さな約束を。</h2><ul class="notice-list"><li><span class="notice-num">01</span><div><b>画面を見るときは、立ち止まる。</b><p>歩いている間は、街の景色を楽しんでください。</p></div></li><li><span class="notice-num">02</span><div><b>入れる場所か、その場で確かめる。</b><p>営業時間や立入制限は変わります。看板・現地の案内を優先してください。</p></div></li><li><span class="notice-num">03</span><div><b>気が進まなければ、引き返す。</b><p>暗い道や不安な場所を避け、無理のない散歩を。</p></div></li></ul>${button('accept','わかりました、はじめる')}<p class="subtle">歩行中の位置はブラウザ内で処理します。出発地のみ、ルート作成時にサーバーへ送ります。</p>`;
      event('#accept','click',()=>{storage.set('notice',true);go('mood');});
    } else if (s === 'mood') {
      app.innerHTML = `${progress(1)}<h2>今日は、<br>どんな気分ですか。</h2><p class="lead">うまく言葉にならなくても、大丈夫。<br>いま思い浮かんだ、一言から。</p><form id="mood-form"><label for="mood" class="field">いまの気分</label><textarea id="mood" class="text-field" maxlength="200" required placeholder="たとえば、キラキラ。少し懐かしい。">${esc(state.mood)}</textarea><p class="subtle">「緑を感じたい」「映画の中みたいな」でも。</p>${errorBox()}<button class="primary" type="submit">気分をほどく</button></form>`;
      event('#mood-form','submit',async e=>{e.preventDefault();state.mood=$('#mood').value.trim();if(!state.mood)return setError('いまの気分を一言入力してください。');await request('clarify',{mood:state.mood},'choices','mood');});
    } else if (s === 'choices') {
      app.innerHTML = `${progress(2)}<span class="pill">${esc(state.mood)}</span><h2>${esc(state.clarify.question)}</h2><p class="lead">いまの自分に近いものを、ひとつ。</p><div>${state.clarify.options.map((o,i)=>`<button type="button" class="choice" data-option="${i}">${esc(o.label)}</button>`).join('')}</div><div class="divider">自分の言葉でも</div><form id="preference-form"><label class="field" for="preference">もう少し伝える</label><input id="preference" class="text-field" maxlength="200" placeholder="どんなふうに過ごしたい？" value="${esc(state.preference)}"><label class="field" for="crowd">人の多さは？</label><select id="crowd" class="text-field"><option value="neutral">どちらでも</option><option value="avoid">混雑を避けたい</option><option value="ok">にぎやかでいい</option></select>${errorBox()}<button type="submit" class="primary">この気分で歩く</button></form><div class="actions">${button('back','戻る','text-button')}${button('surprise','おまかせ','text-button')}</div>`;
      app.querySelectorAll('[data-option]').forEach(b=>b.addEventListener('click',()=>{const o=state.clarify.options[Number(b.dataset.option)];state.preference=o.label;state.crowd=o.crowd;go('setup');}));
      event('#preference-form','submit',e=>{e.preventDefault();state.preference=$('#preference').value.trim();if(!state.preference)return setError('気分を入力するか、選択肢・おまかせを選んでください。');state.crowd=$('#crowd').value;go('setup');});
      event('#surprise','click',()=>{state.preference=state.mood;state.crowd='neutral';go('setup');});event('#back','click',()=>go('mood'));
    } else if (s === 'setup') {
      app.innerHTML = `${progress(3)}<h2>どこから、<br>どのくらい歩こう。</h2><p class="lead">${esc(state.preference)}</p><form id="setup-form"><fieldset style="border:0;padding:0;margin:0"><legend class="field">散歩の時間</legend><div class="duration-options">${[30,45,60].map(n=>`<label class="duration-option"><input type="radio" name="minutes" value="${n}" ${state.minutes===n?'checked':''}><span>${n}分</span></label>`).join('')}</div></fieldset><label class="field">出発地</label>${button('locate','◎ 現在地を使う','secondary')}<p id="geo-status" class="subtle" role="status">${mock?'見本は京都・清水寺周辺の固定ルートです。':'地図をタップするか、座標を入力してください。'}</p>${mapMarkup()}<div class="coords"><div><label for="lat" class="field">緯度</label><input id="lat" class="text-field" type="number" step="any" min="-90" max="90" required value="${state.origin.lat}"></div><div><label for="lon" class="field">経度</label><input id="lon" class="text-field" type="number" step="any" min="-180" max="180" required value="${state.origin.lon}"></div></div>${errorBox()}<button class="primary" type="submit">ルートをつくる</button></form>${button('back','気分の選択に戻る','text-button')}${state.excluded.length?button('clear-excluded','外した場所の記録をリセット','text-button'):''}`;
      event('#locate','click',locate);event('#back','click',()=>go('choices'));
      event('#clear-excluded','click',()=>{state.excluded=[];storage.set('excluded',[]);go('setup');});
      event('#setup-form','submit',async e=>{e.preventDefault();state.origin={lat:Number($('#lat').value),lon:Number($('#lon').value)};state.minutes=Number(new FormData(e.target).get('minutes'));if(!validPoint(state.origin))return setError('出発地の座標を確認してください。');await createRoute('setup');});
      setupMap().catch(e=>setError(e.message));
    } else if (s === 'loading') {
      app.setAttribute('aria-busy','true');app.innerHTML=`${progress(4)}<div class="waiting"><div class="loader" aria-hidden="true">↗</div><h2>${state.pending==='clarify'?'気分を、ほどいています。':'気分と街を、つないでいます。'}</h2><p id="waiting-text" class="lead" role="status">${mock?'見本データを読み込んでいます。':'少しだけ、お待ちください。'}</p><p class="time"><span id="elapsed">0</span>秒経過</p><p class="subtle">${mock?'このモードではAI・地図APIを呼びません。':'通常10〜40秒ほど。混雑時は長くかかることがあります。'}</p>${button('cancel','キャンセル','text-button')}</div>`;
      const start=Date.now();timer=setInterval(()=>{const t=Math.floor((Date.now()-start)/1000);$('#elapsed').textContent=t;if(t>=10)$('#waiting-text').textContent=t>=40?'時間がかかっています。キャンセルしてやり直すこともできます。':'まだ処理中です。もう少しお待ちください。';},1000);
      event('#cancel','click',()=>{requestToken++;controller?.abort();go(state.returnScreen);});
    } else if (s === 'route') {
      app.innerHTML=`${progress(4)}<div class="summary"><div><span class="eyebrow">TODAY’S WALK</span><h2>今日の、よりみち。</h2></div><div><strong>${esc(Math.round(state.route.total_minutes))}</strong><small>分</small></div></div><p class="lead">${esc(state.route.interpretation)}</p>${mapMarkup()}${attribution()}<div id="route-details" ${mock?'':'hidden'}><ol class="place-list">${state.route.places.map((p,i)=>`<li class="place-card"><span class="place-number">${i+1}</span><div><span class="place-kind">${esc(p.kind)}</span><h3>${esc(p.name)}</h3><p>${esc(p.hint)}</p><p class="distance">出発地から直線 ${formatDistance(distanceMeters(state.origin,p))}</p>${p.warning?`<p class="warning">△ ${esc(p.warning)}</p>`:''}${link(p.maps_uri,'Google Mapsで見る')}</div><button type="button" class="remove" data-remove="${i}" aria-label="${esc(p.name)}を外す">外す</button></li>`).join('')}</ol><div class="sources">${(state.route.sources||[]).map(x=>link(x.uri,x.title)).join(' ')}</div></div>${errorBox()}<button id="start" type="button" class="primary" ${mock?'':'disabled'}>歩きはじめる</button><p class="subtle">所要時間は目安です。実際の道順は地図と現地で確認してください。</p>${button('back','時間・出発地を変更する','text-button')}`;
      event('#start','click',()=>{state.index=0;state.position=null;state.geoMessage='';go('walk');if(!mock)startWatch();});event('#back','click',()=>go('setup'));
      app.querySelectorAll('[data-remove]').forEach(b=>b.addEventListener('click',async()=>{const id=state.route.places[Number(b.dataset.remove)].id;state.excluded=[...new Set([...state.excluded,id])].slice(-200);storage.set('excluded',state.excluded);await createRoute('route');}));
      resultMap().then(()=>{if(state.screen==='route'&&!mapsAuthError){$('#route-details').hidden=false;$('#start').disabled=false;}}).catch(e=>setError(e.message));
    } else if (s === 'walk') {
      const p=state.route.places[state.index];
      app.innerHTML=`${progress(4)}<span class="pill">${state.index+1} / ${state.route.places.length} か所目</span><h2>次の、よりみちへ。</h2><div class="compass" aria-hidden="true">↗</div><p id="walk-distance" class="walk-distance"></p><p id="walk-direction" class="subtle"></p><div id="walk-details" ${mock?'':'hidden'}><h3 style="margin-top:25px">${esc(p.name)}</h3><p class="lead">${esc(p.hint)}</p>${p.warning?`<p class="warning">△ ${esc(p.warning)}</p>`:''}</div>${mock?'':mapMarkup()+attribution()}<p id="geo-status" class="subtle" role="status"></p>${errorBox()}${button('arrive','着いた','primary')}<p class="subtle">スマホはしまって大丈夫。画面を見るときは立ち止まってください。直線距離・方角の表示は道案内ではありません。</p>${mock?`<div class="mock-tools"><p>見本モードの操作確認</p>${button('simulate','この場所への到着を再現','secondary')} ${button('watch','現在地で到着判定を試す','secondary')}</div>`:button('watch','現在地の取得を再試行','text-button')}${button('stop','散歩を終了する','text-button')}`;
      if(!mock)resultMap().then(()=>{if(state.screen==='walk'&&!mapsAuthError)$('#walk-details').hidden=false;}).catch(e=>setError(e.message));
      updateWalk();event('#arrive','click',arrive);event('#simulate','click',()=>{const pos={...p,accuracy:10,timestamp:Date.now()};receivePosition(pos);});event('#watch','click',startWatch);event('#stop','click',()=>{stopWatch();go('done');});
    } else if(s === 'arrived') {
      app.innerHTML=`<div class="quiet"><span class="eyebrow">YOU ARE HERE</span><h2>ここからは、<br>スマホをしまって。</h2>${button('next','次へ歩く')}</div>`;event('#next','click',()=>go('rating'));
    } else if(s === 'rating') {
      app.innerHTML=`${progress(4)}<span class="pill">${state.index+1}か所目の振り返り</span><h2>求めていた<br>「${esc(state.mood)}」を<br>感じられた？</h2><p class="lead">あなたの感覚で、ひとつだけ。</p><div class="rating" role="group" aria-label="5段階の評価">${[1,2,3,4,5].map(n=>`<button type="button" data-rating="${n}" aria-label="${n}点：${['感じなかった','あまり感じなかった','どちらともいえない','少し感じた','感じた'][n-1]}">${n}</button>`).join('')}</div><div class="rating-labels"><span>感じなかった</span><span>感じた</span></div><p class="subtle">評価はこのブラウザにだけ保存されます。</p>${button('skip','答えずに次へ','text-button')}`;
      app.querySelectorAll('[data-rating]').forEach(b=>b.addEventListener('click',()=>{const existing=storage.get('ratings',[]);storage.set('ratings',[...(Array.isArray(existing)?existing:[]),{id:state.route.places[state.index].id,score:Number(b.dataset.rating),at:new Date().toISOString()}].slice(-100));nextPlace();}));event('#skip','click',nextPlace);
    } else if(s === 'done') {
      app.innerHTML=`${progress(4)}<div class="finish-mark" aria-hidden="true">↗</div><h2>おつかれさまでした。</h2><p class="lead">いつもの街に、<br>少しだけ違う景色が増えたなら。</p>${button('again','また、よりみちする')}${button('erase','このブラウザの評価・除外記録を消す','text-button')}<p id="erase-status" class="subtle" role="status"></p>`;event('#again','click',()=>{state.route=null;state.position=null;go('mood');});event('#erase','click',()=>{storage.set('ratings',[]);storage.set('excluded',[]);state.excluded=[];$('#erase-status').textContent='評価と外した場所の記録を消しました。';});
    } else if(s === 'blocked') {
      stopWatch();app.innerHTML=`<p role="alert">${esc(state.blocked)}</p>`;
    }
  }
  function formatDistance(m) { return m>=1000?`${(m/1000).toFixed(1)} km`:`${Math.round(m)} m`; }
  function routeBody() { return {mood:state.mood,preference:state.preference,crowd:state.crowd,lat:state.origin.lat,lon:state.origin.lon,minutes:state.minutes,exclude_ids:state.excluded,include_ids:[]}; }
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
  function loadMaps() {
    if(mapsAuthError)return Promise.reject(new Error('Googleマップの認証に失敗しています。キーの設定後、ページを再読み込みしてください。'));
    if(window.google?.maps?.geometry)return Promise.resolve();
    if(mapPromise)return mapPromise;
    mapPromise=(async()=>{
      if(!window.MAPS_JS_API_KEY) await new Promise(resolve=>{const script=document.createElement('script');script.src='./config.js';script.onload=resolve;script.onerror=resolve;document.head.append(script);});
      if(!window.MAPS_JS_API_KEY)throw new Error('Googleマップの設定がありません。web/config.jsを設定してください。見本はURL末尾に ?mock=1 を付けて試せます。');
      await new Promise((resolve,reject)=>{
        const script=document.createElement('script');const timeout=setTimeout(()=>{script.remove();reject(new Error('Googleマップの読み込みが時間切れになりました。'));},20000);
        const fail=()=>{clearTimeout(timeout);reject(new Error('Googleマップを読み込めませんでした。キーのAPI制限・URL制限を確認してください。'));};
        window.yorimichiMapReady=()=>{clearTimeout(timeout);resolve();};
        window.gm_authFailure=()=>{mapsAuthError=true;fail();if(!mock){$('#walk-details')?.setAttribute('hidden','');$('#route-details')?.setAttribute('hidden','');if($('#start'))$('#start').disabled=true;setError('Googleマップの認証に失敗しました。キーの設定を確認してください。');}};
        const params=new URLSearchParams({key:window.MAPS_JS_API_KEY,callback:'yorimichiMapReady',libraries:'geometry',v:'weekly',language:'ja',loading:'async'});
        script.src=`https://maps.googleapis.com/maps/api/js?${params}`;script.onerror=fail;document.head.append(script);
      });
    })().catch(e=>{mapPromise=null;throw e;});return mapPromise;
  }
  function mockMap() {
    const el=$('#map');if(!el)return;const places=state.screen==='route'?state.route.places:[];
    el.innerHTML=`<svg viewBox="0 0 440 250" role="img" aria-label="道路ではない操作確認用の模式図"><rect width="440" height="250" fill="#e9ecdf"/><path d="M-10 60L450 170M70 -10L190 270M310 -10L200 270M-10 220L450 55" fill="none" stroke="#faf9f3" stroke-width="24"/><path d="M300 32Q382 20 377 95Q370 146 318 127Z" fill="#d3dfbe"/><path class="map-line" d="M85 190 Q130 136 200 151 T345 75"/><circle class="map-pin" cx="85" cy="190" r="9"/>${places.map((p,i)=>`<circle class="map-pin" cx="${150+i*65}" cy="${165-i*30}" r="13"/><text x="${150+i*65}" y="${169-i*30}" text-anchor="middle" fill="white" font-size="11">${i+1}</text>`).join('')}<text class="map-note" x="20" y="28">KYOTO / SAMPLE</text><text class="map-note" x="20" y="232">見本の模式図 · 実際の道路とは異なります</text></svg>`;
  }
  async function setupMap() {
    if(mock){mockMap();return;}
    const container=$('#map');await loadMaps();if(state.screen!=='setup'||$('#map')!==container)return;
    map=new google.maps.Map(container,{center:{lat:state.origin.lat,lng:state.origin.lon},zoom:15,streetViewControl:false,mapTypeControl:false,fullscreenControl:false});
    const marker=new google.maps.Marker({map,position:{lat:state.origin.lat,lng:state.origin.lon},title:'出発地'});overlays.push(marker);
    map.addListener('click',e=>{state.origin={lat:e.latLng.lat(),lon:e.latLng.lng()};$('#lat').value=state.origin.lat.toFixed(6);$('#lon').value=state.origin.lon.toFixed(6);marker.setPosition(e.latLng);});
    const update=()=>{const point={lat:Number($('#lat').value),lon:Number($('#lon').value)};if(validPoint(point)){state.origin=point;marker.setPosition({lat:point.lat,lng:point.lon});map.panTo({lat:point.lat,lng:point.lon});}};
    event('#lat','change',update);event('#lon','change',update);
  }
  async function resultMap() {
    if(mock){mockMap();return;}
    const screen=state.screen,container=$('#map');await loadMaps();if(state.screen!==screen||$('#map')!==container)return;
    map=new google.maps.Map(container,{center:{lat:state.origin.lat,lng:state.origin.lon},zoom:15,streetViewControl:false,mapTypeControl:false,fullscreenControl:false});
    const bounds=new google.maps.LatLngBounds();const start={lat:state.origin.lat,lng:state.origin.lon};bounds.extend(start);
    const path=google.maps.geometry.encoding.decodePath(state.route.polyline);
    if(path.length<2)throw new Error('歩く道の線を読み取れませんでした。もう一度ルートを作ってください。');
    overlays.push(new google.maps.Polyline({map,path,strokeColor:'#294d3c',strokeWeight:5,strokeOpacity:.9}));path.forEach(p=>bounds.extend(p));
    overlays.push(new google.maps.Marker({map,position:start,title:'出発地',label:'発'}));
    state.route.places.forEach((p,i)=>{const position={lat:p.lat,lng:p.lon};bounds.extend(position);overlays.push(new google.maps.Marker({map,position,label:String(i+1),title:p.name}));});map.fitBounds(bounds,35);
    if(screen==='walk'&&state.position)updateUserMarker();
  }
  function locate() {
    if(!navigator.geolocation)return setError('このブラウザでは現在地を取得できません。地図か座標で指定してください。');
    const b=$('#locate');b.disabled=true;$('#geo-status').textContent='現在地を確認しています…';
    navigator.geolocation.getCurrentPosition(pos=>{if(state.screen!=='setup')return;state.origin={lat:pos.coords.latitude,lon:pos.coords.longitude};$('#lat').value=state.origin.lat.toFixed(6);$('#lon').value=state.origin.lon.toFixed(6);$('#geo-status').textContent=`出発地を設定しました（位置の精度：約${Math.round(pos.coords.accuracy)}m）。`;b.disabled=false;if(map){const p={lat:state.origin.lat,lng:state.origin.lon};map.panTo(p);overlays[0]?.setPosition(p);}},()=>{if(state.screen!=='setup')return;b.disabled=false;$('#geo-status').textContent='現在地を取得できませんでした。地図か座標で指定できます。';},{enableHighAccuracy:true,timeout:12000,maximumAge:0});
  }
  function startWatch() {
    stopWatch();if(state.screen!=='walk')return;
    if(!navigator.geolocation){state.geoMessage='現在地を取得できません。「着いた」ボタンで進めます。';updateWalk();return;}
    state.geoMessage='現在地を確認しています…';updateWalk();
    watch=navigator.geolocation.watchPosition(p=>receivePosition({lat:p.coords.latitude,lon:p.coords.longitude,accuracy:p.coords.accuracy,timestamp:p.timestamp}),()=>{state.geoMessage='現在地を取得できません。「着いた」ボタンで進めます。';updateWalk();},{enableHighAccuracy:true,timeout:15000,maximumAge:5000});
  }
  function receivePosition(p) {
    if(state.screen!=='walk'||!validPoint(p))return;state.position=p;state.geoMessage=`位置の精度：約${Math.round(p.accuracy)}m${p.accuracy>50?'。自動到着の判定を保留しています。':''}`;
    if(isArrival(p,state.route.places[state.index])){arrive();return;}updateWalk();
  }
  function updateUserMarker() {
    if(!map||!state.position)return;const p={lat:state.position.lat,lng:state.position.lon};
    if(userMarker)userMarker.setPosition(p);else{userMarker=new google.maps.Marker({map,position:p,title:'現在地',icon:{path:google.maps.SymbolPath.CIRCLE,scale:7,fillColor:'#3978c2',fillOpacity:1,strokeColor:'white',strokeWeight:2}});overlays.push(userMarker);}
  }
  function updateWalk() {
    if(state.screen!=='walk')return;updateUserMarker();const p=state.route.places[state.index],from=state.position||state.origin;
    $('#walk-distance').textContent=formatDistance(distanceMeters(from,p));$('#walk-direction').textContent=`${state.position?'現在地':'出発地'}から直線・${directionLabel(from,p)}の方角（端末の向きではありません）`;$('#geo-status').textContent=state.geoMessage||'現在地はまだ取得していません。「着いた」でも進めます。';
  }
  function arrive() {stopWatch();go('arrived');}
  function nextPlace() {state.index++;state.position=null;state.geoMessage='';if(state.index>=state.route.places.length){stopWatch();go('done');}else{go('walk');if(!mock)startWatch();}}
  window.addEventListener('pagehide',()=>{stopWatch();controller?.abort();clearInterval(timer);});
  render();
}

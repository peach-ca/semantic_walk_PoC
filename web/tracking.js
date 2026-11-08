import { MAX_TRACK_POINTS } from './storage.js';
export function trackDistance(a,b) {
  const rad=n=>n*Math.PI/180, dlat=rad(b.lat-a.lat),dlon=rad(b.lon-a.lon);
  const h=Math.sin(dlat/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dlon/2)**2;
  return 6371000*2*Math.atan2(Math.sqrt(h),Math.sqrt(Math.max(0,1-h)));
}
export function validTrackPoint(p,now=Date.now()) {
  return p && p.simulated !== true && Number.isFinite(p.lat) && Math.abs(p.lat)<=90 && Number.isFinite(p.lon) && Math.abs(p.lon)<=180 &&
    Number.isFinite(p.accuracy) && p.accuracy>=0 && p.accuracy<=100 && Number.isFinite(p.timestamp) && Math.abs(now-p.timestamp)<=30000;
}
export function createWalkTracker({store,now=Date.now,onChange=()=>{}}) {
  let current=null, error='';
  function status() { return {active:current?.status==='active',id:current?.id??null,count:current?.points.length??0,status:current?.status??'off',error}; }
  function emit() { onChange(status()); }
  function persist() {
    try {store.save(current);error='';return true;}
    catch(e) {error=e.message||'位置履歴を保存できませんでした。';current=null;return false;}
  }
  function finish(reason='completed') {
    if(current?.status==='active'){current.status=reason;current.ended_at=now();persist();}
    emit();
  }
  return {
    status,
    start(id,{enabled=false,mock=false}={}) {
      if(current?.status==='active')finish('interrupted');current=null;error='';
      if(enabled){current={version:1,id,started_at:now(),ended_at:null,status:'active',mock,points:[]};persist();}
      emit();return status();
    },
    record(point) {
      if(current?.status!=='active'||!validTrackPoint(point,now()))return false;
      const last=current.points.at(-1);
      if(last){const elapsed=point.timestamp-last.timestamp;if(elapsed<10000 || (elapsed<60000&&trackDistance(last,point)<5))return false;}
      // センサーの応答オブジェクトを丸ごと保存せず、必要な4項目だけを残す。
      current.points.push({lat:point.lat,lon:point.lon,accuracy:point.accuracy,timestamp:point.timestamp});
      if(current.points.length>=MAX_TRACK_POINTS){current.status='limit';current.ended_at=now();}
      const saved=persist();emit();return saved;
    },
    finish,
    clearAll() {
      // 先に書き込みを止め、削除後のGPS更新で履歴が復活しないようにする。
      current=null;error='';try{store.clear();}catch(e){error=e.message||'位置履歴を削除できませんでした。';}emit();return !error;
    }
  };
}

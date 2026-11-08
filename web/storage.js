// 位置履歴だけを保存する。通信処理・Googleの場所情報の保存は行わない。
export const TRACK_KEY = 'yorimichi:tracks:v1';
export const MAX_TRACKS = 20, MAX_TRACK_POINTS = 1200, MAX_TOTAL_POINTS = 6000;
export const TRACK_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const statuses = new Set(['active', 'completed', 'stopped', 'interrupted', 'limit']);
export function normalizeTracks(raw, now = Date.now()) {
  if (!Array.isArray(raw)) return [];
  const valid = [];
  for (const item of raw.slice(-MAX_TRACKS)) {
    if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 128 || !Number.isFinite(item.started_at) || item.started_at > now + 30000) continue;
    const ended = Number.isFinite(item.ended_at) && item.ended_at >= item.started_at && item.ended_at <= now + 30000 ? item.ended_at : null;
    if (now - (ended ?? item.started_at) > TRACK_RETENTION_MS) continue;
    const points = []; let last = -Infinity;
    for (const p of Array.isArray(item.points) ? item.points.slice(0, MAX_TRACK_POINTS) : []) {
      if (!p || !Number.isFinite(p.lat) || Math.abs(p.lat) > 90 || !Number.isFinite(p.lon) || Math.abs(p.lon) > 180 ||
          !Number.isFinite(p.accuracy) || p.accuracy < 0 || p.accuracy > 100 || !Number.isFinite(p.timestamp) ||
          p.timestamp < item.started_at - 30000 || p.timestamp > (ended ?? now) + 30000 || p.timestamp <= last) continue;
      points.push({lat: Number(p.lat.toFixed(6)), lon: Number(p.lon.toFixed(6)), accuracy: Number(p.accuracy.toFixed(1)), timestamp: Math.round(p.timestamp)});
      last = p.timestamp;
    }
    valid.push({version:1,id:item.id,started_at:item.started_at,ended_at:ended,status:statuses.has(item.status)?item.status:'interrupted',mock:item.mock===true,points});
  }
  // 同じ散歩IDは最後のレコードを採用し、古い散歩から件数・総点数を制限する。
  const unique = [...new Map(valid.map(t => [t.id, t])).values()].sort((a,b)=>a.started_at-b.started_at);
  let total = unique.reduce((n,t)=>n+t.points.length,0);
  while (total > MAX_TOTAL_POINTS && unique.length > 1) total -= unique.shift().points.length;
  return unique;
}
export function createTrackStore({backend, now = Date.now} = {}) {
  // localStorageが禁止されている場合も、作成時ではなく読み書き時に例外を受け取る。
  const storage = backend ?? {getItem:k=>globalThis.localStorage.getItem(k),setItem:(k,v)=>globalThis.localStorage.setItem(k,v),removeItem:k=>globalThis.localStorage.removeItem(k)};
  function read() {
    try {
      const text=storage.getItem(TRACK_KEY);
      return normalizeTracks(text ? JSON.parse(text) : [],now());
    } catch { throw new Error('位置履歴を読み出せません。ブラウザの保存設定を確認してください。'); }
  }
  function write(tracks) {
    const normalized = normalizeTracks(tracks,now());
    try { storage.setItem(TRACK_KEY,JSON.stringify(normalized)); }
    catch { throw new Error('位置履歴を保存できません。容量やブラウザの設定を確認してください。'); }
    return normalized;
  }
  return {
    list: read,
    save(track) { return write([...read().filter(t=>t.id!==track.id),track]); },
    prune() { return write(read()); },
    remove(id) { return write(read().filter(t=>t.id!==id)); },
    clear() { try { storage.removeItem(TRACK_KEY); } catch { throw new Error('位置履歴を削除できませんでした。'); } }
  };
}

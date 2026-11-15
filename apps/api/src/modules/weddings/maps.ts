/**
 * Pulls coordinates out of a pasted Google Maps / Apple Maps / OSM link without a network call
 * (SET-03a). Short links (maps.app.goo.gl) need a server-side redirect follow — later story.
 */
const ALLOWED_HOSTS = /(^|\.)(google\.[a-z.]+|goo\.gl|maps\.apple\.com|openstreetmap\.org)$/i;

export interface PinFromLink {
  lat: number;
  lng: number;
  placeId?: string;
}

export function parseMapsLink(link: string): PinFromLink | 'host_not_allowed' | null {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!ALLOWED_HOSTS.test(url.hostname)) return 'host_not_allowed';

  const pair = (s: string | null | undefined) => {
    const m = s ? /(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)/.exec(s) : null;
    if (!m) return null;
    const lat = Number(m[1]);
    const lng = Number(m[2]);
    return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
  };

  const placeId = url.searchParams.get('query_place_id') ?? undefined;
  const at = /@(-?\d+\.\d+),(-?\d+\.\d+)/.exec(url.pathname);
  const fromPath = /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/.exec(url.pathname + url.search);
  const found =
    (fromPath && { lat: Number(fromPath[1]), lng: Number(fromPath[2]) }) ||
    pair(url.searchParams.get('q')) ||
    pair(url.searchParams.get('query')) ||
    pair(url.searchParams.get('ll')) ||
    pair(url.searchParams.get('destination')) ||
    (at && { lat: Number(at[1]), lng: Number(at[2]) }) ||
    pair(url.hash.replace(/^#map=\d+\//, '').replace('/', ','));
  return found ? { ...found, ...(placeId ? { placeId } : {}) } : null;
}

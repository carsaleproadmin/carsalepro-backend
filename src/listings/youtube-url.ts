const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);

/** Extracts the only value persisted for a listing video: YouTube's 11-char id. */
export function youtubeVideoIdFromUrl(value: string): string | null {
  if (value.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }

  if (url.protocol !== 'https:') return null;
  if (url.username || url.password || url.port) return null;

  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);
  let videoId: string | null = null;
  if (host === 'youtu.be') {
    if (parts.length === 1) videoId = parts[0] ?? null;
  } else if (YOUTUBE_HOSTS.has(host)) {
    if (url.pathname === '/watch') {
      videoId = url.searchParams.get('v');
    } else {
      const [kind, id] = parts;
      if (parts.length === 2 && (kind === 'shorts' || kind === 'embed')) {
        videoId = id ?? null;
      }
    }
  }

  return videoId && YOUTUBE_VIDEO_ID.test(videoId) ? videoId : null;
}

/** class-transformer adapter: blank clears; invalid input survives for validation to reject. */
export function transformYoutubeUrlInput(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'string') return value;
  if (value.trim() === '') return null;
  // Never pass the raw value to the ID validator. A bare 11-character string
  // would otherwise satisfy the ID regex even though the API contract accepts
  // URLs only.
  return youtubeVideoIdFromUrl(value) ?? '__invalid_youtube_url__';
}

import { applyDecorators } from '@nestjs/common';
import { IsOptional, ValidateBy, type ValidationOptions } from 'class-validator';

/** The only value persisted for a listing video: YouTube's 11-char id. */
export const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

const MAX_URL_LENGTH = 2048;

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

/** Path prefixes that put the video id in the next segment. */
const ID_PATH_KINDS = new Set(['shorts', 'embed', 'live', 'v']);

/**
 * Extracts the video id from a YouTube link, or returns null.
 *
 * Accepts the share forms a seller copies: watch, youtu.be, Shorts, embed,
 * live and the nocookie embed, with or without `https://`. A plain `http:`
 * link is accepted too, because only the id is kept.
 */
export function youtubeVideoIdFromUrl(value: string): string | null {
  if (value.length > MAX_URL_LENGTH) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;

  let url: URL;
  try {
    // A link copied from the address bar can come without a scheme.
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || url.port) return null;

  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);
  let videoId: string | null = null;
  if (host === 'youtu.be') {
    if (parts.length === 1) videoId = parts[0] ?? null;
  } else if (YOUTUBE_HOSTS.has(host)) {
    if (parts.length === 1 && parts[0] === 'watch') {
      videoId = url.searchParams.get('v');
    } else if (parts.length === 2 && ID_PATH_KINDS.has(parts[0] ?? '')) {
      videoId = parts[1] ?? null;
    }
  }

  return videoId && YOUTUBE_VIDEO_ID.test(videoId) ? videoId : null;
}

/**
 * The stored value for a `youtubeUrl` field of a request body.
 *
 * `undefined` leaves the stored video alone. `null` or a blank string clears
 * it. Call it only after `IsYoutubeUrl` accepted the value.
 */
export function youtubeVideoIdForStorage(
  value: string | null | undefined,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value.trim() === '') return null;
  return youtubeVideoIdFromUrl(value);
}

/**
 * Validates an optional YouTube link. `null` and a blank string are accepted,
 * because they clear the video. The field keeps the URL; the service extracts
 * the id with `youtubeVideoIdForStorage`.
 */
export function IsYoutubeUrl(options?: ValidationOptions): PropertyDecorator {
  return applyDecorators(
    IsOptional(),
    ValidateBy(
      {
        name: 'isYoutubeUrl',
        validator: {
          validate: (value: unknown) =>
            typeof value === 'string' &&
            (value.trim() === '' || youtubeVideoIdFromUrl(value) !== null),
          defaultMessage: () => 'youtubeUrl must be a valid YouTube video URL',
        },
      },
      options,
    ),
  );
}

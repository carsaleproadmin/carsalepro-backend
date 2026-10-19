import { youtubeVideoIdFromUrl } from './youtube-url';

describe('youtubeVideoIdFromUrl', () => {
  it.each([
    ['https://youtu.be/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=43s',
      'dQw4w9WgXcQ',
    ],
    ['https://youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://m.youtube.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
  ])('extracts the id from %s', (input, expected) => {
    expect(youtubeVideoIdFromUrl(input)).toBe(expected);
  });

  it.each([
    'https://example.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ',
    'https://studio.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com/watch?v=too-short',
    'https://youtube.com/playlist?list=PL123',
    'javascript:alert(1)',
    'http://youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ/extra',
    'https://youtube.com:444/watch?v=dQw4w9WgXcQ',
  ])('rejects %s', (input) => {
    expect(youtubeVideoIdFromUrl(input)).toBeNull();
  });

  it('rejects an oversized URL before parsing it', () => {
    expect(youtubeVideoIdFromUrl(`https://youtu.be/dQw4w9WgXcQ?${'x'.repeat(2048)}`)).toBeNull();
  });
});

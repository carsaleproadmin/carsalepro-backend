import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { youtubeVideoIdForStorage } from '../youtube-url';
import { UpdateListingDto } from './update-listing.dto';

async function errorsFor(body: Record<string, unknown>) {
  const dto = plainToInstance(UpdateListingDto, body);
  return { dto, errors: await validate(dto, { whitelist: true, forbidNonWhitelisted: true }) };
}

describe('UpdateListingDto youtubeUrl', () => {
  it('accepts a supported YouTube link and keeps it as a URL', async () => {
    const { dto, errors } = await errorsFor({ youtubeUrl: ' https://youtu.be/dQw4w9WgXcQ?t=43 ' });
    expect(errors).toHaveLength(0);
    expect(dto.youtubeUrl).toBe(' https://youtu.be/dQw4w9WgXcQ?t=43 ');
    expect(youtubeVideoIdForStorage(dto.youtubeUrl)).toBe('dQw4w9WgXcQ');
  });

  it.each([null, '   '])('accepts %p for removal', async (youtubeUrl) => {
    const { dto, errors } = await errorsFor({ youtubeUrl });
    expect(errors).toHaveLength(0);
    expect(youtubeVideoIdForStorage(dto.youtubeUrl)).toBeNull();
  });

  it('leaves the stored video alone when the field is absent', async () => {
    const { dto, errors } = await errorsFor({});
    expect(errors).toHaveLength(0);
    expect(youtubeVideoIdForStorage(dto.youtubeUrl)).toBeUndefined();
  });

  it.each([
    'dQw4w9WgXcQ',
    'abcdefghijk',
    'https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=too-short',
    123,
  ])('rejects invalid input %p', async (youtubeUrl) => {
    const { errors } = await errorsFor({ youtubeUrl });
    expect(errors).not.toHaveLength(0);
  });

  it('rejects the response field name instead of dropping it silently', async () => {
    const { errors } = await errorsFor({ youtubeVideoId: 'dQw4w9WgXcQ' });
    expect(errors.map((error) => error.property)).toContain('youtubeVideoId');
  });
});

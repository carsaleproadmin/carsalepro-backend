import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { youtubeVideoIdForStorage } from '../youtube-url';
import { CreateManualListingDto } from './create-manual-listing.dto';

async function errorsFor(body: Record<string, unknown>) {
  const dto = plainToInstance(CreateManualListingDto, body);
  return { dto, errors: await validate(dto, { whitelist: true, forbidNonWhitelisted: true }) };
}

describe('CreateManualListingDto youtubeUrl', () => {
  it('accepts a supported URL', async () => {
    const { dto, errors } = await errorsFor({ youtubeUrl: 'https://youtube.com/shorts/dQw4w9WgXcQ' });
    expect(errors).toHaveLength(0);
    expect(youtubeVideoIdForStorage(dto.youtubeUrl)).toBe('dQw4w9WgXcQ');
  });

  it.each([
    'https://studio.youtube.com/watch?v=dQw4w9WgXcQ',
    'dQw4w9WgXcQ',
    'abcdefghijk',
  ])('rejects invalid URL input %s', async (youtubeUrl) => {
    const { errors } = await errorsFor({ youtubeUrl });
    expect(errors).not.toHaveLength(0);
  });

  it('rejects the response field name instead of dropping it silently', async () => {
    const { errors } = await errorsFor({ youtubeVideoId: 'dQw4w9WgXcQ' });
    expect(errors.map((error) => error.property)).toContain('youtubeVideoId');
  });
});

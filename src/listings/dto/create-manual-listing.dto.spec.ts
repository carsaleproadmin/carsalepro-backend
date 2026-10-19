import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateManualListingDto } from './create-manual-listing.dto';

describe('CreateManualListingDto youtubeUrl', () => {
  it('extracts the video id from a supported URL', async () => {
    const dto = plainToInstance(CreateManualListingDto, {
      youtubeUrl: 'https://youtube.com/shorts/dQw4w9WgXcQ',
    });
    expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).toHaveLength(0);
    expect(dto.youtubeVideoId).toBe('dQw4w9WgXcQ');
  });

  it.each([
    'https://studio.youtube.com/watch?v=dQw4w9WgXcQ',
    'dQw4w9WgXcQ',
    'abcdefghijk',
  ])('rejects invalid URL input %s', async (youtubeUrl) => {
    const dto = plainToInstance(CreateManualListingDto, {
      youtubeUrl,
    });
    expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).not.toHaveLength(0);
  });
});

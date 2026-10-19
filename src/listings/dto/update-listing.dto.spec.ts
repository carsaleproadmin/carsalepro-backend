import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateListingDto } from './update-listing.dto';

async function youtubeUrlFrom(value: unknown) {
  const dto = plainToInstance(UpdateListingDto, { youtubeUrl: value });
  return { dto, errors: await validate(dto, { whitelist: true, forbidNonWhitelisted: true }) };
}

describe('UpdateListingDto youtubeUrl', () => {
  it('normalizes a supported YouTube link', async () => {
    const { dto, errors } = await youtubeUrlFrom(' https://youtu.be/dQw4w9WgXcQ?t=43 ');
    expect(errors).toHaveLength(0);
    expect(dto.youtubeVideoId).toBe('dQw4w9WgXcQ');
  });

  it('accepts null for removal', async () => {
    const { dto, errors } = await youtubeUrlFrom(null);
    expect(errors).toHaveLength(0);
    expect(dto.youtubeVideoId).toBeNull();
  });

  it('accepts a blank string for removal', async () => {
    const { dto, errors } = await youtubeUrlFrom('   ');
    expect(errors).toHaveLength(0);
    expect(dto.youtubeVideoId).toBeNull();
  });

  it.each([
    'dQw4w9WgXcQ',
    'abcdefghijk',
    'https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=too-short',
    123,
  ])('rejects invalid input %p', async (value) => {
    const { errors } = await youtubeUrlFrom(value);
    expect(errors).not.toHaveLength(0);
  });
});

import { BadRequestException } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  KycUploadPart,
  MAX_KYC_UPLOAD_BYTES,
  resolveKycObject,
  sniffKycFormat,
} from './kyc-upload';

const fixture = (name: string): Buffer =>
  readFileSync(join(__dirname, '..', '..', 'test', 'fixtures', name));

/** Minimal but structurally valid headers, so the sniffer is tested on real bytes. */
const HEADERS: Record<string, Buffer> = {
  pdf: Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64, 0x20)]),
  jpeg: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]),
  png: Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64),
  ]),
  webp: Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.from([0x24, 0x00, 0x00, 0x00]),
    Buffer.from('WEBPVP8 '),
    Buffer.alloc(64),
  ]),
  gif: Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(64)]),
  tiffLE: Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00]), Buffer.alloc(64)]),
  tiffBE: Buffer.concat([Buffer.from([0x4d, 0x4d, 0x00, 0x2a]), Buffer.alloc(64)]),
};

function part(over: Partial<KycUploadPart> = {}): KycUploadPart {
  return {
    mimetype: 'image/jpeg',
    originalname: 'id.jpg',
    buffer: HEADERS.jpeg,
    size: HEADERS.jpeg.length,
    ...over,
  };
}

/** The `error.code` a thrown BadRequestException carries, or null. */
function codeOf(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (err) {
    if (!(err instanceof BadRequestException)) throw err;
    const response = err.getResponse() as { error?: { code?: string } };
    return response.error?.code ?? null;
  }
}

describe('sniffKycFormat', () => {
  it.each(Object.entries(HEADERS))('recognises %s', (name, buffer) => {
    const expected = name.startsWith('tiff') ? 'tiff' : name;
    expect(sniffKycFormat(buffer)).toBe(expected);
  });

  it('finds a PDF header that is not at offset 0', () => {
    const withJunk = Buffer.concat([Buffer.alloc(40, 0x0a), HEADERS.pdf]);
    expect(sniffKycFormat(withJunk)).toBe('pdf');
  });

  it('does not recognise an SVG, an HTML page, a ZIP or arbitrary bytes', () => {
    expect(sniffKycFormat(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffKycFormat(Buffer.from('<!doctype html><html><body>hello</body></html>'))).toBeNull();
    expect(sniffKycFormat(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
    expect(sniffKycFormat(fixture('not-an-image.bin'))).toBeNull();
  });

  it('returns null for a file too short to hold any signature', () => {
    expect(sniffKycFormat(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull();
  });
});

describe('resolveKycObject', () => {
  it('plans an image upload: compress, store as JPEG, key extension .jpg', () => {
    const plan = resolveKycObject(part({ mimetype: 'image/png', buffer: HEADERS.png }));
    expect(plan).toEqual({
      family: 'image',
      sniffed: 'png',
      compress: true,
      storedContentType: 'image/jpeg',
      extension: 'jpg',
    });
  });

  it('accepts a real camera JPEG fixture', () => {
    const plan = resolveKycObject(part({ buffer: fixture('photo-4000x3000.jpg') }));
    expect(plan.sniffed).toBe('jpeg');
    expect(plan.compress).toBe(true);
  });

  it('stores a PDF as-is, uncompressed, with a .pdf extension', () => {
    const plan = resolveKycObject(
      part({ mimetype: 'application/pdf', originalname: 'gewerbeschein.pdf', buffer: HEADERS.pdf }),
    );
    expect(plan).toEqual({
      family: 'pdf',
      sniffed: 'pdf',
      compress: false,
      storedContentType: 'application/pdf',
      extension: 'pdf',
    });
  });

  it('never yields a .bin extension for anything it accepts', () => {
    const cases: Array<[string, Buffer]> = [
      ['image/jpeg', HEADERS.jpeg],
      ['image/png', HEADERS.png],
      ['image/webp', HEADERS.webp],
      ['image/gif', HEADERS.gif],
      ['image/tiff', HEADERS.tiffLE],
      ['application/pdf', HEADERS.pdf],
    ];
    for (const [mimetype, buffer] of cases) {
      const plan = resolveKycObject(part({ mimetype, buffer }));
      expect(['jpg', 'pdf']).toContain(plan.extension);
    }
  });

  /*
   * THE DEFECT THIS FILE EXISTS FOR. The presign endpoint validated an OPTIONAL
   * `contentType` BODY field with `if (contentType && ALLOWED.test(...))`, so a
   * client that simply omitted it skipped the check. Here the type comes from
   * the multipart part, and an absent one is a refusal, not a pass.
   */
  it('refuses a part with no content type instead of waving it through', () => {
    expect(codeOf(() => resolveKycObject(part({ mimetype: undefined })))).toBe(
      'unsupported_content_type',
    );
    expect(codeOf(() => resolveKycObject(part({ mimetype: '' })))).toBe(
      'unsupported_content_type',
    );
    // multer's default when a part carries no Content-Type header.
    expect(codeOf(() => resolveKycObject(part({ mimetype: 'application/octet-stream' })))).toBe(
      'unsupported_content_type',
    );
  });

  it('refuses an executable/archive/text type outright', () => {
    for (const mimetype of [
      'application/zip',
      'text/html',
      'application/x-msdownload',
      'video/mp4',
    ]) {
      expect(codeOf(() => resolveKycObject(part({ mimetype })))).toBe('unsupported_content_type');
    }
  });

  it('refuses an SVG even though `image/svg+xml` is an image/* type', () => {
    // An SVG is a script container, and the reviewer opens KYC documents from a
    // signed URL in their own browser.
    expect(
      codeOf(() =>
        resolveKycObject(
          part({ mimetype: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="x"><script/></svg>') }),
        ),
      ),
    ).toBe('unsupported_content_type');
  });

  it('refuses bytes that are not any accepted format, whatever the header says', () => {
    expect(
      codeOf(() => resolveKycObject(part({ mimetype: 'image/png', buffer: fixture('not-an-image.bin') }))),
    ).toBe('unsupported_content_type');
  });

  it('refuses a PDF wearing an image content type, and vice versa', () => {
    expect(
      codeOf(() => resolveKycObject(part({ mimetype: 'image/jpeg', buffer: HEADERS.pdf }))),
    ).toBe('content_type_mismatch');
    expect(
      codeOf(() => resolveKycObject(part({ mimetype: 'application/pdf', buffer: HEADERS.png }))),
    ).toBe('content_type_mismatch');
  });

  it('tolerates a charset parameter and odd casing on the part header', () => {
    expect(
      resolveKycObject(part({ mimetype: 'Application/PDF; charset=binary', buffer: HEADERS.pdf }))
        .family,
    ).toBe('pdf');
    expect(resolveKycObject(part({ mimetype: ' IMAGE/JPEG ' })).family).toBe('image');
  });

  it('refuses an empty or missing buffer with file_required', () => {
    expect(codeOf(() => resolveKycObject(part({ buffer: Buffer.alloc(0) })))).toBe('file_required');
    expect(codeOf(() => resolveKycObject(part({ buffer: undefined })))).toBe('file_required');
  });

  it('refuses anything past the size ceiling, measured on the bytes held', () => {
    const huge = Buffer.concat([HEADERS.jpeg, Buffer.alloc(MAX_KYC_UPLOAD_BYTES)]);
    // `size` deliberately lies: the check must read the buffer, not the claim.
    expect(codeOf(() => resolveKycObject(part({ buffer: huge, size: 10 })))).toBe('file_too_large');
  });
});

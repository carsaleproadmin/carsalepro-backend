/**
 * The CJK PDF font packs the mobile app downloads on demand.
 *
 * These are NOT bundled in the app. Android and iOS both ship CJK system faces,
 * so ~33 MB in the binary would buy nothing at run time — but `package:pdf`
 * embeds its own fonts and cannot use the platform's, so a Chinese, Japanese or
 * Korean report needs a real file. It is fetched the first time one is
 * generated and cached on the device.
 *
 * Why we mirror these rather than pointing the app at fonts.gstatic.com:
 * gstatic is unreachable from mainland China, which is the single largest market
 * for the locale it would be serving.
 *
 * Why the SHA-256 matters: a truncated TrueType file does not throw when parsed.
 * It yields a font whose glyph metrics are all zero, and the report renders with
 * invisible text and nothing in the logs.
 *
 * Upload with `npx ts-node scripts/upload-fonts.ts <dir>`. It verifies each
 * file against the digest below BEFORE uploading, so a corrupted local copy
 * cannot be published; it never rewrites this table, because a manifest that
 * regenerates itself from whatever is on disk checks nothing.
 */
export interface FontPackFile {
  /** Name the app stores it under. */
  name: string;
  /** Object key inside the reports bucket. */
  key: string;
  /** Lowercase hex SHA-256 of the exact bytes. */
  sha256: string;
  bytes: number;
  /** Which pack this file belongs to — `PdfFontSet.id` on the app side. */
  pack: string;
}

/** Everything under this prefix is a font; nothing else writes there. */
export const FONT_KEY_PREFIX = 'fonts/v1';

/**
 * Noto Sans SC is a coverage superset of TC and JP (CJK URO 20 976/20 992 plus
 * kana), so one pack serves zh, zh-Hant and ja. Korean needs its own — SC has
 * no Hangul at all.
 *
 * Both are the Google Fonts **static per-weight TTF instances**, not the
 * noto-cjk releases: `package:pdf` decides a font is usable with
 * `bytes.getUint32(0) == 0x10000`, so an OTF ("OTTO") or a .ttc ("ttcf")
 * degrades to zero glyph metrics instead of failing.
 */
export const FONT_MANIFEST: FontPackFile[] = [
  {
    name: 'NotoSansSC-Regular.ttf',
    key: `${FONT_KEY_PREFIX}/NotoSansSC-Regular.ttf`,
    sha256: '450625c8d46ab3df97b7904ded955ec2746d17ec76740cb1e91d1ba63a0f89af',
    bytes: 10540644,
    pack: 'noto-sans-sc',
  },
  {
    name: 'NotoSansSC-Bold.ttf',
    key: `${FONT_KEY_PREFIX}/NotoSansSC-Bold.ttf`,
    sha256: '0066a522a1ac007c1d72bc4fccb114f80ff7294641c78cead9715bd14d43b9ea',
    bytes: 10530408,
    pack: 'noto-sans-sc',
  },
  {
    name: 'NotoSansKR-Regular.ttf',
    key: `${FONT_KEY_PREFIX}/NotoSansKR-Regular.ttf`,
    sha256: '5ebb0def0fe9e7c853253eca8ec9c1066adc479f2e248533b412ed0c6a663abc',
    bytes: 6159248,
    pack: 'noto-sans-kr',
  },
  {
    name: 'NotoSansKR-Bold.ttf',
    key: `${FONT_KEY_PREFIX}/NotoSansKR-Bold.ttf`,
    sha256: 'c733940a7dc687142848b30a491e97138ed58dc58c4cae33c44e3ee52da411cb',
    bytes: 6163256,
    pack: 'noto-sans-kr',
  },
];

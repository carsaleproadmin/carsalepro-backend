import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import sharp from 'sharp';
import { MrzIdentity, parseMrz } from './mrz';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Recognise the machine-readable zone on an identity document.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHAT THIS IS FOR (DEN-250). `KycDocument.sha256` recognises the same FILE,
 * so a rejected applicant who photographs the same passport again is a
 * stranger to it. The document NUMBER survives re-photographing, and the MRZ
 * is where a document states its own number in a form a machine can read.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A FAILED READ IS A NON-EVENT. THIS IS THE MOST IMPORTANT RULE HERE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every failure path returns `null`, and `null` means the platform behaves
 * exactly as it did before this existed. Not "suspicious", not "retry", not a
 * lower score. The reasons are not equal but the outcome must be:
 *
 *  - a national identity card from outside the EU may carry no MRZ at all;
 *  - a passport photographed at an angle, in bad light, or with the bottom of
 *    the page cropped off, has one that cannot be read;
 *  - the recogniser or its language data may be unavailable on this server.
 *
 * An applicant whose camera or whose country's document format is the problem
 * must never be treated as an impostor. The alternative - "unreadable means
 * held for review" - would refuse work to honest people for owning the wrong
 * bureaucracy, which is worse than the fraud it would catch.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THE OUTPUT CAN BE TRUSTED AT ALL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Nothing here decides whether a read is good. `parseMrz` accepts a zone only
 * when three independent ICAO check digits agree with it, so a single misread
 * character throws the whole read away. That is why this service has no
 * confidence threshold to tune: it is arithmetic, not a judgement.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE LANGUAGE DATA IS A THIRD PARTY, AND A THIRD PARTY MUST NOT FAIL A BOOT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `tesseract.js` fetches `eng.traineddata` from a CDN unless it is given a
 * local path. Set `KYC_MRZ_TESSDATA_PATH` to a directory holding that file to
 * keep the read entirely inside the server. With the variable unset the
 * download is attempted once; if it fails, this service switches itself off for
 * a cool-down and says so once, rather than logging a stack trace per upload.
 *
 * `KYC_MRZ_OCR_ENABLED=false` turns it off outright.
 */

/**
 * How long one read may take before it is abandoned.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE READ RUNS INSIDE THE UPLOAD REQUEST, AND ONE WORKER SERVES ALL OF THEM
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Without a deadline a recogniser that never returns holds the applicant's HTTP
 * request open for ever - and because `tesseract.js` queues every job onto the
 * single worker this service keeps, it holds every LATER KYC upload in the same
 * process behind it too. One unlucky photograph would stop the whole intake,
 * not just its own.
 *
 * Twenty seconds is far above what a real read costs (a prepared 2000 px image
 * is a second or two) and far below any patience an upload has. Passing the
 * deadline is an ordinary failure: it gives `null`, exactly as an unreadable
 * document does, and the applicant is not treated differently for it.
 */
const READ_DEADLINE_MS = 20_000;

/**
 * How long the service stays off after the recogniser could not be created.
 *
 * See `retryAfter`. Long enough that an absent component is not retried on
 * every upload, short enough that a blip does not need a deploy to clear.
 */
const UNAVAILABLE_COOLDOWN_MS = 10 * 60_000;

/** Text recognition, kept behind an interface so the worker can be faked. */
export interface MrzRecogniser {
  recognise(image: Buffer): Promise<string>;
  /** Releases the child process. Absent on a fake. */
  terminate?(): Promise<void>;
}

@Injectable()
export class MrzOcrService implements OnModuleDestroy {
  private readonly logger = new Logger(MrzOcrService.name);

  /** Created on first use, then reused: starting a worker costs seconds. */
  private worker: Promise<MrzRecogniser> | null = null;

  /**
   * When the recogniser may be tried again, as a millisecond clock reading.
   *
   * It used to be a boolean that was set once and never cleared, so ANY failure
   * - including a network blip while the language data was fetched the very
   * first time - switched the OCR off until the process was restarted. A
   * component that is genuinely absent and one that was briefly unreachable are
   * not the same thing, and only the first deserves a permanent answer.
   *
   * A cool-down gives both what they need: an absent component costs one
   * attempt per `UNAVAILABLE_COOLDOWN_MS` rather than one per upload, and a
   * blip heals itself.
   */
  private retryAfter = 0;

  constructor(private readonly config: ConfigService) {}

  isEnabled(): boolean {
    return this.config.get<boolean>('kyc.mrzOcrEnabled') !== false && Date.now() >= this.retryAfter;
  }

  /**
   * Read the zone off one document image, or return `null`.
   *
   * @param image the SOURCE bytes of the upload, before compression
   */
  async read(image: Buffer): Promise<MrzIdentity | null> {
    if (!this.isEnabled()) return null;

    const startedAt = Date.now();
    try {
      const recogniser = await this.getWorker();
      const prepared = await this.prepare(image);
      const text = await this.withDeadline(recogniser.recognise(prepared));
      const identity = parseMrz(text);
      this.logger.log(
        `MRZ read ${identity ? `OK (${identity.format}, ${identity.issuingState})` : 'found nothing'}` +
          ` in ${Date.now() - startedAt} ms`,
      );
      return identity;
    } catch (err) {
      // One line, no stack: an unreadable document is an ordinary event and
      // must not look like a fault in the log of a server that is working.
      this.logger.warn(`MRZ read failed after ${Date.now() - startedAt} ms: ${String(err)}`);
      return null;
    }
  }

  /**
   * Give up on a read that passes `READ_DEADLINE_MS`.
   *
   * The recognition itself is not cancelled - `tesseract.js` offers no way to
   * do that - so the worker may still be busy when this rejects. That is
   * accepted: the point is to free the REQUEST, and the cost of a worker that
   * stays busy is paid by the deadline on the next read rather than by a
   * connection that never closes.
   */
  private async withDeadline<T>(work: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    // The losing side of a race is still a live promise. When the deadline wins
    // and the recognition rejects afterwards, that rejection has no handler and
    // Node reports it as unhandled - a crash on the default setting. This
    // swallows only the LATE failure; the one that arrives in time is still
    // returned by the race below.
    work.catch(() => undefined);
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`no answer in ${READ_DEADLINE_MS} ms`)),
            READ_DEADLINE_MS,
          );
          // The process must not be kept alive by a timer that is only waiting
          // to report a failure.
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Flatten the photograph into what a text recogniser can work with.
   *
   * The zone is a band of monospaced OCR-B at the bottom of the document, so
   * the colour, the hologram and the portrait are all noise. Greyscale, a
   * normalised histogram and a fixed width give the recogniser the one thing
   * it needs - dark glyphs on a light ground at a stable size.
   *
   * The image is NOT cropped to the bottom third. That is where the zone is on
   * a passport page held the right way up, and it is the wrong place on a
   * photograph taken upside down, on a card scanned in landscape, or on the
   * back of an identity card where the zone occupies most of the surface.
   * Cropping trades a little speed for reads that fail on how the applicant
   * held the phone.
   */
  private async prepare(image: Buffer): Promise<Buffer> {
    return sharp(image)
      .rotate() // honour the EXIF orientation before anything else
      .resize({ width: 2000, withoutEnlargement: true })
      .greyscale()
      .normalise()
      .png()
      .toBuffer();
  }

  private getWorker(): Promise<MrzRecogniser> {
    if (!this.worker) this.worker = this.createWorker();
    return this.worker;
  }

  private async createWorker(): Promise<MrzRecogniser> {
    try {
      // Imported here rather than at the top of the file: the package pulls in
      // a WebAssembly runtime, and a server that never receives a KYC upload
      // should not pay for it at boot.
      const { createWorker } = (await import('tesseract.js')) as typeof import('tesseract.js');
      const langPath = this.config.get<string>('kyc.mrzTessdataPath');
      // `cachePath` is set even when the data comes from a CDN. Left to its
      // default, the library writes the 5 MB `eng.traineddata` into the
      // process's WORKING DIRECTORY - the deployment root on Render, and the
      // repository root when a developer runs it, where it was found untracked
      // and nearly committed.
      const worker = await createWorker('eng', undefined, {
        cachePath: join(tmpdir(), 'carsalepro-tessdata'),
        ...(langPath ? { langPath } : {}),
      });

      // The zone is OCR-B over a 37-character alphabet. Telling the recogniser
      // so removes most of the substitutions the check digits would otherwise
      // have to catch - `0`/`O`, `1`/`I`, `5`/`S`, `8`/`B`.
      await worker.setParameters({
        tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<',
      });

      return {
        recognise: async (img: Buffer) => (await worker.recognize(img)).data.text,
        terminate: async () => {
          await worker.terminate();
        },
      };
    } catch (err) {
      // Switched off for a cool-down, not for the life of the process. Retrying
      // on every upload would mean a multi-second delay on each one for a
      // component that has already proved absent; retrying never means a blip
      // at the wrong moment costs a deploy to clear.
      this.retryAfter = Date.now() + UNAVAILABLE_COOLDOWN_MS;
      this.worker = null;
      this.logger.warn(
        `MRZ recognition is UNAVAILABLE: ${String(err)}. ` +
          `Off for the next ${UNAVAILABLE_COOLDOWN_MS / 60_000} minutes, then tried again. ` +
          'Document numbers will not be compared; nothing else changes.',
      );
      throw err;
    }
  }

  async onModuleDestroy(): Promise<void> {
    // The worker holds a child process; a test suite that leaves it running
    // never exits.
    const pending = this.worker;
    this.worker = null;
    if (!pending) return;
    await pending.then((w) => w.terminate?.()).catch(() => undefined);
  }
}

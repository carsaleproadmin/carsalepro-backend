import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../../config/configuration';
import { AppleValidator } from './apple-validator';
import { GoogleValidator } from './google-validator';
import {
  IapValidationError,
  IapValidationMode,
  IapValidationRequest,
  IapValidationResult,
} from './iap.types';

@Injectable()
export class IapValidatorService {
  private readonly logger = new Logger(IapValidatorService.name);
  private readonly mode: IapValidationMode;

  constructor(
    config: ConfigService<AppConfig, true>,
    private readonly apple: AppleValidator,
    private readonly google: GoogleValidator,
  ) {
    this.mode = config.get('iap', { infer: true }).mode;
    this.logger.log(
      `IAP validation mode: ${this.mode} (apple=${this.apple.isConfigured()}, google=${this.google.isConfigured()})`,
    );
  }

  /**
   * Validate a receipt. In `client-trust` mode the call is a no-op that
   * returns a synthetic "valid" result so legacy callers keep working.
   */
  async validate(req: IapValidationRequest): Promise<IapValidationResult> {
    if (this.mode === 'client-trust') {
      return {
        valid: true,
        platform: req.platform,
        productId: req.productId,
        environment: 'Unknown',
        provider: 'client-trust',
      };
    }

    // Server mode FAILS CLOSED: every path below either returns a verified
    // result or throws. A missing credential is 503 `iap_not_configured`, not a
    // grant and not a "your receipt is bad".
    if (req.platform === 'ios') {
      if (!this.apple.isConfigured()) {
        throw new IapValidationError(
          'iap_not_configured',
          'Apple validation requested but APPLE_ISSUER_ID / APPLE_KEY_ID / APPLE_PRIVATE_KEY are not configured',
        );
      }
      return this.apple.validate(req);
    }
    if (req.platform === 'android') {
      if (!this.google.isConfigured()) {
        throw new IapValidationError(
          'iap_not_configured',
          'Google validation requested but GOOGLE_PLAY_SA_JSON is not configured',
        );
      }
      return this.google.validate(req);
    }
    throw new IapValidationError(
      'iap_platform_unsupported',
      `Unsupported platform: ${req.platform as string}`,
    );
  }

  get currentMode(): IapValidationMode {
    return this.mode;
  }
}

import { Body, Controller, Get, HttpCode, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/auth.decorators';
import { UpdateInspectorProfileDto } from './dto/inspector-profile.dto';
import { RegisterPushTokenDto, RegisterPushTokenResultDto } from './dto/push-token.dto';
import { StartStripeOnboardingDto } from './dto/stripe-onboarding.dto';
import {
  EarningsResponse,
  InspectorProfileView,
  InspectorService,
  OnboardingStatusResponse,
  StripeOnboardingResponse,
} from './inspector.service';

@ApiTags('inspector')
@ApiBearerAuth()
@Controller('api/v1/inspector')
export class InspectorController {
  constructor(private readonly inspector: InspectorService) {}

  @Get('profile')
  @ApiOperation({ summary: "Get the caller's inspector profile (or { exists:false })" })
  async getProfile(
    @CurrentUser('id') userId: string,
  ): Promise<InspectorProfileView | { exists: false }> {
    return this.inspector.getProfile(userId);
  }

  @Patch('profile')
  @ApiOperation({ summary: "Create/update the caller's inspector profile + base location" })
  async updateProfile(
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateInspectorProfileDto,
  ): Promise<InspectorProfileView> {
    return this.inspector.upsertProfile(userId, dto);
  }

  @Post('push-token')
  @HttpCode(200)
  @ApiOperation({
    summary: "Register/refresh the caller's FCM push token for push notifications",
  })
  async registerPushToken(
    @CurrentUser('id') userId: string,
    @Body() dto: RegisterPushTokenDto,
  ): Promise<RegisterPushTokenResultDto> {
    await this.inspector.registerPushToken(userId, dto.token);
    return { ok: true };
  }

  @Post('stripe-onboarding')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Begin/resume Stripe Connect Express onboarding for the caller',
    description:
      'Optionally names the payout account country (ISO 3166-1 alpha-2) and its legal form. ' +
      'An empty body keeps whatever is stored, so an older client is unaffected.',
  })
  async stripeOnboarding(
    @CurrentUser('id') userId: string,
    @Body() dto: StartStripeOnboardingDto,
  ): Promise<StripeOnboardingResponse> {
    return this.inspector.startStripeOnboarding(userId, dto);
  }

  @Get('onboarding-status')
  @ApiOperation({ summary: 'Stripe onboarding + offer-eligibility status for the caller' })
  async onboardingStatus(
    @CurrentUser('id') userId: string,
  ): Promise<OnboardingStatusResponse> {
    return this.inspector.getOnboardingStatus(userId);
  }

  @Get('earnings')
  @ApiOperation({ summary: "The caller's payout earnings summary (pending/paid + list)" })
  async earnings(@CurrentUser('id') userId: string): Promise<EarningsResponse> {
    return this.inspector.getEarnings(userId);
  }
}

import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * Register (or refresh) the caller's push token. FCM registration tokens are
 * opaque and have grown over time — 4096 is the documented upper bound and is
 * deliberately generous so a future token format cannot silently 400.
 */
export class RegisterPushTokenDto {
  @ApiProperty({
    example: 'fMEP0v...:APA91bH...',
    maxLength: 4096,
    description: 'FCM registration token for this device.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  token!: string;
}

/** Result of POST /api/v1/inspector/push-token. */
export class RegisterPushTokenResultDto {
  @ApiProperty({ example: true })
  ok!: boolean;
}

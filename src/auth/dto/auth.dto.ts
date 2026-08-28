import {
  IsBoolean,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  AUTH_VALIDATION_CODES as CODE,
  EMAIL_PATTERN,
  NAME_MAX,
  NAME_PATTERN,
  PASSWORD_MAX,
  PASSWORD_MIN,
  PASSWORD_PATTERN,
} from '../auth-validation';

/*
 * The rules themselves are in `auth-validation.ts`, next to the reasoning for
 * each one - including why the password character set is NOT applied at
 * sign-in. The messages are codes: the web app serves 35 languages and maps
 * them into its own catalogue (DEN-187).
 */

export class RegisterDto {
  @IsEmail({}, { message: CODE.email })
  @Matches(EMAIL_PATTERN, { message: CODE.email })
  email!: string;

  // Optional because an OAuth account has no password of its own.
  @IsOptional()
  @IsString()
  @MinLength(PASSWORD_MIN, { message: CODE.passwordLength })
  @MaxLength(PASSWORD_MAX, { message: CODE.passwordLength })
  @Matches(PASSWORD_PATTERN, { message: CODE.passwordCharset })
  password?: string;

  @IsOptional()
  @IsString()
  @MaxLength(NAME_MAX, { message: CODE.nameLength })
  @Matches(NAME_PATTERN, { message: CODE.name })
  name?: string;

  @IsOptional()
  @IsString()
  locale?: string;

  @IsBoolean()
  gdprConsent!: boolean;
}

export class LoginDto {
  @IsEmail({}, { message: CODE.email })
  @Matches(EMAIL_PATTERN, { message: CODE.email })
  email!: string;

  /*
   * The shape of the password and nothing else. The character set and the
   * length floor are NOT checked here on purpose: accounts exist whose
   * passwords predate both rules, and enforcing them at sign-in would lock
   * those people out with a message about punctuation. Only the hash decides.
   */
  @IsString()
  @IsNotEmpty({ message: CODE.passwordLength })
  @MaxLength(PASSWORD_MAX, { message: CODE.passwordLength })
  password!: string;
}

export class PasswordResetRequestDto {
  @IsEmail()
  email!: string;
}

export class PasswordResetConfirmDto {
  @IsString()
  @IsNotEmpty()
  token!: string;

  // A password is CREATED here, so the full policy applies, exactly as it does
  // at registration.
  @IsString()
  @MinLength(PASSWORD_MIN, { message: CODE.passwordLength })
  @MaxLength(PASSWORD_MAX, { message: CODE.passwordLength })
  @Matches(PASSWORD_PATTERN, { message: CODE.passwordCharset })
  password!: string;
}

export class VerifyEmailDto {
  @IsString()
  @IsNotEmpty()
  token!: string;
}

/**
 * Ask for another confirmation link (DEN-200). The address is the only input:
 * the endpoint is unauthenticated, because the reader who needs it is often the
 * one whose session has gone.
 */
export class ResendVerificationDto {
  @IsEmail({}, { message: CODE.email })
  email!: string;
}

export class OAuthUpsertDto {
  @IsEmail({}, { message: CODE.email })
  email!: string;

  /*
   * NOT held to NAME_PATTERN. This name comes from Google, not from a form:
   * nobody can retype it, and a profile that says "Anna (CarSale)" or carries
   * a degree after a comma would be refused a sign-in over punctuation. It is
   * length-capped and stored as given.
   */
  @IsOptional()
  @IsString()
  @MaxLength(NAME_MAX, { message: CODE.nameLength })
  name?: string;

  @IsString()
  @IsNotEmpty()
  provider!: string;

  @IsString()
  @IsNotEmpty()
  providerAccountId!: string;
}

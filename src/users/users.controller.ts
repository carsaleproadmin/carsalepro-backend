import { Body, Controller, Delete, Get, HttpCode, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/auth.decorators';
import { UpdateMeDto } from './dto/users.dto';
import { UsersService } from './users.service';

@ApiTags('users')
@ApiBearerAuth()
@Controller('api/v1/users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  @ApiOperation({ summary: 'Current user profile' })
  getMe(@CurrentUser('id') userId: string) {
    return this.users.getMe(userId);
  }

  @Patch('me')
  @ApiOperation({ summary: 'Update profile (name, phone, locale, notification prefs)' })
  updateMe(@CurrentUser('id') userId: string, @Body() dto: UpdateMeDto) {
    return this.users.updateMe(userId, dto);
  }

  @Delete('me')
  @HttpCode(204)
  @ApiOperation({ summary: 'GDPR erasure — anonymize PII and revoke access' })
  async eraseMe(@CurrentUser('id') userId: string): Promise<void> {
    await this.users.eraseMe(userId);
  }
}

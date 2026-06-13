import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/auth.decorators';
import { UpdateInspectorProfileDto } from './dto/inspector-profile.dto';
import { InspectorProfileView, InspectorService } from './inspector.service';

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
}

import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { AdminAuditService } from './admin-audit.service';
import { AdminLegalService } from './admin-legal.service';
import { ActivateLegalVersionDto, CreateLegalVersionDto } from './dto/admin-legal.dto';

@ApiTags('admin')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller('api/v1/admin/legal-templates')
export class AdminLegalController {
  constructor(
    private readonly legal: AdminLegalService,
    private readonly audit: AdminAuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'All legal templates grouped by key with version history (admin)' })
  listAll() {
    return this.legal.listAll();
  }

  @Get(':key')
  @ApiOperation({ summary: 'Versions for a template key + the active bodyMd (admin)' })
  @ApiParam({ name: 'key', example: 'contract_de' })
  getByKey(@Param('key') key: string) {
    return this.legal.getByKey(key);
  }

  @Post(':key')
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a new template version (admin)' })
  @ApiParam({ name: 'key', example: 'contract_de' })
  async createVersion(
    @CurrentUser('id') adminId: string,
    @Param('key') key: string,
    @Body() dto: CreateLegalVersionDto,
  ) {
    const created = await this.legal.createVersion(key, dto);
    await this.audit.log(adminId, 'legal.create_version', 'legal_template', created.id, null, {
      key: created.key,
      version: created.version,
      active: created.active,
    });
    return {
      id: created.id,
      key: created.key,
      version: created.version,
      locale: created.locale,
      title: created.title,
      active: created.active,
      createdAt: created.createdAt.toISOString(),
    };
  }

  @Post(':key/activate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Activate a specific template version (admin)' })
  @ApiParam({ name: 'key', example: 'contract_de' })
  async activate(
    @CurrentUser('id') adminId: string,
    @Param('key') key: string,
    @Body() dto: ActivateLegalVersionDto,
  ) {
    const activated = await this.legal.activateVersion(key, dto.version);
    await this.audit.log(adminId, 'legal.activate_version', 'legal_template', activated.id, null, {
      key: activated.key,
      version: activated.version,
    });
    return { id: activated.id, key: activated.key, version: activated.version, active: activated.active };
  }
}

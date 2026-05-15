import { Controller, Delete } from '@nestjs/common';
import { ApiHeader, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiProperty } from '@nestjs/swagger';
import { DeviceId } from '../common/decorators/device-id.decorator';
import { EraseResult, MeService } from './me.service';

class EraseResultDto implements EraseResult {
  @ApiProperty({ example: 'b2f24f8e-3b6f-4f3e-8ad4-5e5d2f3a1c40' })
  deviceId!: string;
  @ApiProperty({ example: 3 })
  reportsDeleted!: number;
  @ApiProperty({ example: 3 })
  objectsDeleted!: number;
  @ApiProperty({ example: true })
  quotaDeleted!: boolean;
}

@ApiTags('me')
@ApiHeader({
  name: 'X-Device-Id',
  required: true,
  description: 'UUID v4 of the device requesting erasure.',
})
@Controller('me')
export class MeController {
  constructor(private readonly meService: MeService) {}

  @Delete()
  @ApiOperation({
    summary: 'GDPR right-to-erasure for this device',
    description:
      'Removes all DB rows (reports + quota) and every R2 object stored for this deviceId. ' +
      'Irreversible.',
  })
  @ApiOkResponse({ type: EraseResultDto })
  async erase(@DeviceId() deviceId: string): Promise<EraseResultDto> {
    return this.meService.erase(deviceId);
  }
}

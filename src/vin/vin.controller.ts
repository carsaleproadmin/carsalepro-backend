import { BadRequestException, Controller, Get, Param } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { VinResponseDto } from './dto/vin-response.dto';
import { VinService } from './vin.service';
import { isVinFormat, normalizeVin } from './vin.util';

@ApiTags('vin')
@Controller('vin')
export class VinController {
  constructor(private readonly vinService: VinService) {}

  @Get(':vin')
  @ApiOperation({
    summary: 'Decode a VIN via NHTSA vPIC with Postgres cache',
    description:
      'Cache-first lookup. On miss, fetches from vpic.nhtsa.dot.gov and stores the result. ' +
      'Returns 404 when NHTSA has no meaningful data for the VIN (mobile app must allow manual entry).',
  })
  @ApiParam({ name: 'vin', example: '1HGBH41JXMN109186', description: '17-char VIN' })
  @ApiOkResponse({ type: VinResponseDto })
  async decode(@Param('vin') vinParam: string): Promise<VinResponseDto> {
    const vin = normalizeVin(vinParam);
    if (!isVinFormat(vin)) {
      throw new BadRequestException('VIN must be 17 characters using [A-HJ-NPR-Z0-9]');
    }
    return this.vinService.decode(vin);
  }
}

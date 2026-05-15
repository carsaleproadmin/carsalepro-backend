import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { AppConfig } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import { VinResponseDto } from './dto/vin-response.dto';
import { normalizeVin } from './vin.util';

interface NhtsaResult {
  Variable: string;
  VariableId?: number;
  Value: string | null;
}

interface NhtsaPayload {
  Results: NhtsaResult[];
}

const FIELDS = {
  make: 'Make',
  model: 'Model',
  modelYear: 'Model Year',
  plantCountry: 'Plant Country',
  bodyClass: 'Body Class',
  fuelType: 'Fuel Type - Primary',
} as const;

@Injectable()
export class VinService {
  private readonly logger = new Logger(VinService.name);
  private readonly baseUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly http: HttpService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.baseUrl = config.get('nhtsa', { infer: true }).baseUrl;
  }

  async decode(vinRaw: string): Promise<VinResponseDto> {
    const vin = normalizeVin(vinRaw);

    const cached = await this.prisma.vinCache.findUnique({ where: { vin } });
    if (cached) {
      return this.toDto(vin, cached.payload as unknown as NhtsaPayload, cached.source, true);
    }

    const payload = await this.fetchFromNhtsa(vin);
    if (!this.hasMeaningfulData(payload)) {
      throw new NotFoundException(`No VIN data found for ${vin}`);
    }

    await this.prisma.vinCache.create({
      data: {
        vin,
        // Prisma JSON column accepts plain objects
        payload: payload as unknown as object,
        source: 'nhtsa-vpic',
      },
    });

    return this.toDto(vin, payload, 'nhtsa-vpic', false);
  }

  private async fetchFromNhtsa(vin: string): Promise<NhtsaPayload> {
    const url = `${this.baseUrl}/vehicles/decodevin/${vin}?format=json`;
    try {
      const { data } = await firstValueFrom(this.http.get<NhtsaPayload>(url, { timeout: 5000 }));
      return data;
    } catch (err) {
      this.logger.warn(`NHTSA fetch failed for ${vin}, retrying once`);
      const { data } = await firstValueFrom(this.http.get<NhtsaPayload>(url, { timeout: 8000 }));
      return data;
    }
  }

  private hasMeaningfulData(payload: NhtsaPayload): boolean {
    const make = this.pick(payload, FIELDS.make);
    const model = this.pick(payload, FIELDS.model);
    const year = this.pick(payload, FIELDS.modelYear);
    return Boolean(make || model || year);
  }

  private pick(payload: NhtsaPayload, variable: string): string | null {
    const row = payload.Results?.find((r) => r.Variable === variable);
    const v = row?.Value;
    if (!v || v === '0' || v.toLowerCase() === 'not applicable') return null;
    return v;
  }

  private toDto(vin: string, payload: NhtsaPayload, source: string, cached: boolean): VinResponseDto {
    const modelYearRaw = this.pick(payload, FIELDS.modelYear);
    return {
      vin,
      make: this.pick(payload, FIELDS.make),
      model: this.pick(payload, FIELDS.model),
      modelYear: modelYearRaw ? parseInt(modelYearRaw, 10) || null : null,
      plantCountry: this.pick(payload, FIELDS.plantCountry),
      bodyClass: this.pick(payload, FIELDS.bodyClass),
      fuelType: this.pick(payload, FIELDS.fuelType),
      source,
      cached,
      raw: payload as unknown as Record<string, unknown>,
    };
  }
}

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { LegalTemplate } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateLegalVersionDto,
  LEGAL_TEMPLATE_KEYS,
  LegalTemplateKey,
} from './dto/admin-legal.dto';

@Injectable()
export class AdminLegalService {
  constructor(private readonly prisma: PrismaService) {}

  private assertKey(key: string): LegalTemplateKey {
    if (!(LEGAL_TEMPLATE_KEYS as readonly string[]).includes(key)) {
      throw new BadRequestException({
        error: { code: 'unknown_template_key', message: `Unknown legal template key '${key}'` },
      });
    }
    return key as LegalTemplateKey;
  }

  /** All templates grouped by key with version history (no bodyMd). */
  async listAll() {
    const rows = await this.prisma.legalTemplate.findMany({
      orderBy: [{ key: 'asc' }, { version: 'desc' }],
    });
    const grouped: Record<string, Array<Record<string, unknown>>> = {};
    for (const r of rows) {
      (grouped[r.key] ??= []).push({
        id: r.id,
        version: r.version,
        locale: r.locale,
        title: r.title,
        active: r.active,
        createdAt: r.createdAt.toISOString(),
      });
    }
    return { templates: grouped };
  }

  /** Versions for a key + the active version's bodyMd. */
  async getByKey(key: string) {
    const templateKey = this.assertKey(key);
    const versions = await this.prisma.legalTemplate.findMany({
      where: { key: templateKey },
      orderBy: { version: 'desc' },
    });
    const active = versions.find((v) => v.active) ?? null;
    return {
      key: templateKey,
      versions: versions.map((v) => ({
        id: v.id,
        version: v.version,
        locale: v.locale,
        title: v.title,
        active: v.active,
        createdAt: v.createdAt.toISOString(),
      })),
      active: active
        ? {
            id: active.id,
            version: active.version,
            locale: active.locale,
            title: active.title,
            bodyMd: active.bodyMd,
            createdAt: active.createdAt.toISOString(),
          }
        : null,
    };
  }

  /** Create a new version = max(version)+1; optionally activate it (default true). */
  async createVersion(key: string, dto: CreateLegalVersionDto): Promise<LegalTemplate> {
    const templateKey = this.assertKey(key);
    const activate = dto.activate ?? true;

    const latest = await this.prisma.legalTemplate.findFirst({
      where: { key: templateKey },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const nextVersion = (latest?.version ?? 0) + 1;

    return this.prisma.$transaction(async (tx) => {
      if (activate) {
        await tx.legalTemplate.updateMany({
          where: { key: templateKey, active: true },
          data: { active: false },
        });
      }
      return tx.legalTemplate.create({
        data: {
          key: templateKey,
          version: nextVersion,
          locale: dto.locale,
          title: dto.title,
          bodyMd: dto.bodyMd,
          active: activate,
        },
      });
    });
  }

  /** Activate a specific version, deactivating all others for the key. */
  async activateVersion(key: string, version: number): Promise<LegalTemplate> {
    const templateKey = this.assertKey(key);
    const target = await this.prisma.legalTemplate.findUnique({
      where: { key_version: { key: templateKey, version } },
    });
    if (!target) {
      throw new NotFoundException({
        error: { code: 'not_found', message: `Version ${version} not found for ${templateKey}` },
      });
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.legalTemplate.updateMany({
        where: { key: templateKey, active: true },
        data: { active: false },
      });
      return tx.legalTemplate.update({
        where: { key_version: { key: templateKey, version } },
        data: { active: true },
      });
    });
  }
}

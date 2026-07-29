import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * A candidate inspector returned by the nearest-search. `distanceKm` is the
 * great-circle (geography) distance from the query point in kilometres, rounded
 * to one decimal.
 */
export interface NearestInspector {
  userId: string;
  companyName: string | null;
  displayName: string | null;
  distanceKm: number;
  /** Base-location latitude, so pricing can request a road route to this inspector. */
  lat: number;
  /** Base-location longitude. */
  lng: number;
}

/**
 * All PostGIS access lives here. `InspectorProfile.location`, `Order.location`
 * and `WaitlistEntry.location` are declared `Unsupported("geography(...)")` in
 * Prisma, so they can only be read/written via raw SQL.
 *
 * Convention for geography writes: insert the row first via the Prisma client
 * (location left NULL — for Order this is briefly invalid at the schema level,
 * so Order rows are inserted with a raw INSERT that sets the geography inline;
 * InspectorProfile / WaitlistEntry are nullable and patched after insert with
 * `setInspectorLocation` / `setWaitlistLocation`). Distances use
 * `ST_Distance(geography, geography)` which returns METRES (SRID 4326).
 */
@Injectable()
export class GeoService {
  constructor(private readonly prisma: PrismaService) {}

  /** Set / move an inspector's base location (idempotent UPDATE). */
  async setInspectorLocation(userId: string, lat: number, lng: number): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE inspector_profile
      SET location = ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography
      WHERE user_id = ${userId}
    `;
  }

  /** Set a waitlist entry's location after the row has been inserted. */
  async setWaitlistLocation(id: string, lat: number, lng: number): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE waitlist_entry
      SET location = ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography
      WHERE id = ${id}
    `;
  }

  /**
   * Nearest available, eligible inspectors within `radiusKm` of (lat,lng).
   * Eligibility = user.kycVerified AND profile.stripeOnboarded AND
   * profile.available AND a location is set. Ordered by true distance (KNN
   * `<->` operator), limited to `limit`.
   */
  async findNearestInspectors(
    lat: number,
    lng: number,
    radiusKm: number,
    limit: number,
  ): Promise<NearestInspector[]> {
    const radiusM = radiusKm * 1000;
    const rows = await this.prisma.$queryRaw<
      Array<{
        userId: string;
        companyName: string | null;
        displayName: string | null;
        distanceM: number;
        lat: number;
        lng: number;
      }>
    >(Prisma.sql`
      SELECT
        ip.user_id        AS "userId",
        ip.company_name   AS "companyName",
        u."name"          AS "displayName",
        ST_Distance(
          ip.location,
          ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography
        )                 AS "distanceM",
        ST_Y(ip.location::geometry) AS "lat",
        ST_X(ip.location::geometry) AS "lng"
      FROM inspector_profile ip
      JOIN "user" u ON u.id = ip.user_id
      WHERE u."kycVerified" = true
        AND ip.stripe_onboarded = true
        AND ip.available = true
        AND ip.location IS NOT NULL
        AND ST_DWithin(
          ip.location,
          ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography,
          ${radiusM}
        )
      ORDER BY ip.location <-> ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography
      LIMIT ${limit}
    `);

    return rows.map((r) => ({
      userId: r.userId,
      companyName: r.companyName,
      displayName: r.displayName,
      distanceKm: Math.round((Number(r.distanceM) / 1000) * 10) / 10,
      lat: Number(r.lat),
      lng: Number(r.lng),
    }));
  }

  /**
   * Like {@link findNearestInspectors} but excludes a set of inspector userIds
   * (those already offered/declined for an order). Used by the dispatch cascade.
   */
  async findNearestInspectorsExcluding(
    lat: number,
    lng: number,
    radiusKm: number,
    limit: number,
    excludeUserIds: string[],
  ): Promise<NearestInspector[]> {
    if (excludeUserIds.length === 0) {
      return this.findNearestInspectors(lat, lng, radiusKm, limit);
    }
    const radiusM = radiusKm * 1000;
    const rows = await this.prisma.$queryRaw<
      Array<{
        userId: string;
        companyName: string | null;
        displayName: string | null;
        distanceM: number;
        lat: number;
        lng: number;
      }>
    >(Prisma.sql`
      SELECT
        ip.user_id        AS "userId",
        ip.company_name   AS "companyName",
        u."name"          AS "displayName",
        ST_Distance(
          ip.location,
          ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography
        )                 AS "distanceM",
        ST_Y(ip.location::geometry) AS "lat",
        ST_X(ip.location::geometry) AS "lng"
      FROM inspector_profile ip
      JOIN "user" u ON u.id = ip.user_id
      WHERE u."kycVerified" = true
        AND ip.stripe_onboarded = true
        AND ip.available = true
        AND ip.location IS NOT NULL
        AND ip.user_id NOT IN (${Prisma.join(excludeUserIds)})
        AND ST_DWithin(
          ip.location,
          ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography,
          ${radiusM}
        )
      ORDER BY ip.location <-> ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography
      LIMIT ${limit}
    `);

    return rows.map((r) => ({
      userId: r.userId,
      companyName: r.companyName,
      displayName: r.displayName,
      distanceKm: Math.round((Number(r.distanceM) / 1000) * 10) / 10,
      lat: Number(r.lat),
      lng: Number(r.lng),
    }));
  }

  /** True if an inspector profile currently has a location set. */
  async inspectorHasLocation(userId: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ has: boolean }>>(Prisma.sql`
      SELECT (location IS NOT NULL) AS has
      FROM inspector_profile
      WHERE user_id = ${userId}
    `);
    return rows.length > 0 && rows[0].has === true;
  }
}

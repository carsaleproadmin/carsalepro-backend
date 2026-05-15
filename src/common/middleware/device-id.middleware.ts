import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

export const DEVICE_ID_HEADER = 'x-device-id';

declare module 'express-serve-static-core' {
  interface Request {
    deviceId?: string;
  }
}

@Injectable()
export class DeviceIdMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    const raw = req.headers[DEVICE_ID_HEADER];
    if (typeof raw === 'string' && raw.trim().length > 0) {
      req.deviceId = raw.trim();
    }
    next();
  }
}

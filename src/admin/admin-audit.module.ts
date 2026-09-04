import { Module } from '@nestjs/common';
import { AdminAuditService } from './admin-audit.service';

/**
 * The audit trail on its own, so a feature module can write to it.
 *
 * `AdminModule` imports feature modules (KycModule among them), thus a feature
 * module cannot import `AdminModule` back. KYC decisions still have to be
 * recorded — since automatic approval, `reviewedBy` on the application is the
 * only trace of a decision, and the next decision overwrites it — so the
 * service lives in a module both sides may import.
 */
@Module({
  providers: [AdminAuditService],
  exports: [AdminAuditService],
})
export class AdminAuditModule {}

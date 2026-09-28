-- DEN-376: PRO that an admin gives to an inspector by hand.
ALTER TABLE "inspector_profile" ADD COLUMN "pro_granted_at" TIMESTAMP(3),
ADD COLUMN "pro_granted_by" TEXT;

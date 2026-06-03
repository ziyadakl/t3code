CREATE TABLE "relay_user_entitlements" (
	"user_id" varchar(255) PRIMARY KEY,
	"managed_endpoint_limit" integer,
	"mobile_device_limit" integer,
	"rate_limit_tier" varchar(32),
	"expires_at" varchar(64),
	"reason" text,
	"created_at" varchar(64) NOT NULL,
	"updated_at" varchar(64) NOT NULL,
	CONSTRAINT "chk_relay_user_entitlements_managed_endpoint_limit" CHECK ("managed_endpoint_limit" IS NULL OR "managed_endpoint_limit" >= 0),
	CONSTRAINT "chk_relay_user_entitlements_mobile_device_limit" CHECK ("mobile_device_limit" IS NULL OR "mobile_device_limit" >= 0),
	CONSTRAINT "chk_relay_user_entitlements_rate_limit_tier" CHECK ("rate_limit_tier" IS NULL OR "rate_limit_tier" IN ('standard', 'trusted', 'blocked'))
);

--> statement-breakpoint
ALTER TABLE "relay_managed_endpoint_allocations" ADD COLUMN "deprovision_requested_at" varchar(64);
--> statement-breakpoint
ALTER TABLE "relay_managed_endpoint_allocations" ADD COLUMN "last_deprovision_attempt_at" varchar(64);
--> statement-breakpoint
ALTER TABLE "relay_managed_endpoint_allocations" ADD COLUMN "last_deprovision_error" text;
--> statement-breakpoint
CREATE INDEX "idx_relay_managed_endpoint_allocations_cleanup" ON "relay_managed_endpoint_allocations" ("deprovision_requested_at","updated_at");

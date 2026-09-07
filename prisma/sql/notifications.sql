-- =============================================================================
-- Notification guards
-- =============================================================================
-- The outbox is only useful if its rows cannot lie about their own state.
--
-- Run after `prisma migrate deploy`:
--     npm run prisma:guards
-- =============================================================================

-- A sent delivery says when, and a pending one has not.
--
-- Without this, a retry loop that updated `status` and forgot `sentAt` would
-- leave rows that look delivered and cannot be audited, which is exactly the
-- question support asks first: did the message actually go out, and when.
ALTER TABLE "NotificationDelivery"
  DROP CONSTRAINT IF EXISTS notification_delivery_sent_has_timestamp;

ALTER TABLE "NotificationDelivery"
  ADD CONSTRAINT notification_delivery_sent_has_timestamp CHECK (
    ("status" = 'SENT' AND "sentAt" IS NOT NULL)
    OR ("status" <> 'SENT' AND "sentAt" IS NULL)
  );

-- A failed delivery says why. A silent failure is a bug report nobody can file.
ALTER TABLE "NotificationDelivery"
  DROP CONSTRAINT IF EXISTS notification_delivery_failed_has_reason;

ALTER TABLE "NotificationDelivery"
  ADD CONSTRAINT notification_delivery_failed_has_reason CHECK (
    "status" <> 'FAILED' OR "lastError" IS NOT NULL
  );

-- Attempts only ever go up.
ALTER TABLE "NotificationDelivery"
  DROP CONSTRAINT IF EXISTS notification_delivery_attempts_non_negative;

ALTER TABLE "NotificationDelivery"
  ADD CONSTRAINT notification_delivery_attempts_non_negative CHECK ("attempts" >= 0);

-- The inbox channel is never a preference row: turning off the record would
-- mean losing history rather than being left alone. The application refuses it;
-- so does the table.
ALTER TABLE "NotificationPreference"
  DROP CONSTRAINT IF EXISTS notification_preference_not_in_app;

ALTER TABLE "NotificationPreference"
  ADD CONSTRAINT notification_preference_not_in_app CHECK ("channel" <> 'IN_APP');

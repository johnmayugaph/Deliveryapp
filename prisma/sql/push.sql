-- =============================================================================
-- Web push subscription guards
-- =============================================================================
-- A push subscription is three opaque strings we did not choose and cannot
-- regenerate. If any of them is wrong the encryption succeeds and the message
-- silently goes nowhere — there is no error to catch, because the push service
-- only sees ciphertext it is not meant to understand. So the shape is checked
-- at the boundary and again here.
--
-- Run after `prisma migrate deploy`:
--     npm run prisma:guards
-- =============================================================================

-- The endpoint is a URL the browser gave us, and push services are HTTPS-only.
-- An http:// endpoint means either a corrupted value or somebody trying to
-- redirect encrypted payloads somewhere they can be counted.
ALTER TABLE "WebPushSubscription"
  DROP CONSTRAINT IF EXISTS web_push_endpoint_is_https;

ALTER TABLE "WebPushSubscription"
  ADD CONSTRAINT web_push_endpoint_is_https CHECK ("endpoint" LIKE 'https://%');

-- The client public key is a 65-byte uncompressed P-256 point. Base64url of 65
-- bytes is 87 characters unpadded and 88 with the single '=' some clients add.
-- The exact byte length is checked in the application, where it can be decoded;
-- this catches a truncated or double-encoded value reaching the table by any
-- other route.
ALTER TABLE "WebPushSubscription"
  DROP CONSTRAINT IF EXISTS web_push_p256dh_length;

ALTER TABLE "WebPushSubscription"
  ADD CONSTRAINT web_push_p256dh_length CHECK (char_length("p256dh") BETWEEN 87 AND 88);

-- The auth secret is 16 bytes: 22 characters unpadded, 24 padded.
ALTER TABLE "WebPushSubscription"
  DROP CONSTRAINT IF EXISTS web_push_auth_length;

ALTER TABLE "WebPushSubscription"
  ADD CONSTRAINT web_push_auth_length CHECK (char_length("auth") BETWEEN 22 AND 24);

-- Failures only ever count up, and reset to zero on a success.
ALTER TABLE "WebPushSubscription"
  DROP CONSTRAINT IF EXISTS web_push_failure_count_non_negative;

ALTER TABLE "WebPushSubscription"
  ADD CONSTRAINT web_push_failure_count_non_negative CHECK ("failureCount" >= 0);

-- An expired subscription is a dead one, so it cannot also look healthy. This
-- keeps the delivery pass's filter honest: `expiredAt IS NULL` really does mean
-- "worth attempting", with no second condition to remember.
ALTER TABLE "WebPushSubscription"
  DROP CONSTRAINT IF EXISTS web_push_expired_not_recently_seen;

ALTER TABLE "WebPushSubscription"
  ADD CONSTRAINT web_push_expired_not_recently_seen CHECK (
    "expiredAt" IS NULL OR "expiredAt" >= "lastSeenAt"
  );

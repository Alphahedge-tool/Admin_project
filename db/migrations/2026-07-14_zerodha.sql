-- Zerodha broker row for the admin UI.
--
-- Zerodha Kite Connect does not support a fully headless login, but the admin
-- app can still store the broker config and exchange a browser-issued
-- request_token for an access_token when needed.

INSERT INTO `brokers` (`name`, `created_at`, `updated_at`)
SELECT 'Zerodha', NOW(), NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM `brokers` WHERE LOWER(`name`) LIKE '%zerodha%' OR LOWER(`name`) LIKE '%kite%'
);

SELECT `id`, `name` FROM `brokers` ORDER BY `id`;

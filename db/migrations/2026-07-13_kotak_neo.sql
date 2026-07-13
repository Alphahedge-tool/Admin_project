-- Kotak Neo auto-login: the two credentials the existing schema has nowhere to
-- put, and the broker row itself.
--
-- Kotak's headless login needs UCC + Access Token + MPIN + TOTP secret + mobile
-- number. Four of those already map onto existing columns (account_id, pin,
-- totp_secret, and... nothing for the token), so only two are actually new:
--
--   app_secret  -> Kotak "Access Token" from the Neo API portal. Also where a
--                  Zerodha API Secret goes later, which is why it is not named
--                  kotak_access_token.
--   phone       -> the registered mobile number the login is sent against.
--
-- Both hold credentials, so both are VARBINARY and encrypted by the PHP layer
-- (encrypt_value / decrypt_value) exactly like account_id, pin and totp_secret.
-- app_secret is sized for the worst case: the Kotak access token is a long JWT,
-- and encrypt_value returns base64, which inflates it by roughly a third.
--
-- Safe to re-run: each statement is guarded, so nothing here fails on a second
-- pass or touches a column that already exists.

-- 1. The two new credential columns -------------------------------------------

SET @add_app_secret := (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE `user_broker_configs` ADD COLUMN `app_secret` VARBINARY(4096) DEFAULT NULL AFTER `app_key`',
    'SELECT ''app_secret already exists'''
  )
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'user_broker_configs'
    AND COLUMN_NAME = 'app_secret'
);
PREPARE stmt FROM @add_app_secret;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @add_phone := (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE `user_broker_configs` ADD COLUMN `phone` VARBINARY(255) DEFAULT NULL AFTER `app_secret`',
    'SELECT ''phone already exists'''
  )
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'user_broker_configs'
    AND COLUMN_NAME = 'phone'
);
PREPARE stmt FROM @add_phone;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2. The broker itself ---------------------------------------------------------
-- The admin app matches brokers by NAME (see BrokerConfigDialog's schema
-- matcher), so this string is load-bearing: it has to contain "kotak".

INSERT INTO `brokers` (`name`, `created_at`, `updated_at`)
SELECT 'Kotak Neo', NOW(), NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM `brokers` WHERE LOWER(`name`) LIKE '%kotak%'
);

-- 3. What you should see -------------------------------------------------------

SELECT `id`, `name` FROM `brokers` ORDER BY `id`;
SHOW COLUMNS FROM `user_broker_configs`;

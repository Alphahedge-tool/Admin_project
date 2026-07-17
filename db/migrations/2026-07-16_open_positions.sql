-- open_positions: selected positions "dumped" from the Trade Panel "Get Position"
-- screen, so a user's live open positions can be captured and mapped later.
--
-- Every row is tagged with the user AND the broker account it came from
-- (broker_config_id / broker_name / broker_account_id), which is what lets a row
-- be mapped back to its source account afterwards. One row per instrument per
-- user+account: re-saving the same contract updates it in place rather than
-- piling up duplicates (see the UNIQUE key + the endpoint's upsert).
--
-- The create.php endpoint also creates this table on demand (ensure_open_positions_table),
-- so this migration is the tracked, canonical definition; applying it by hand is
-- optional.

CREATE TABLE IF NOT EXISTS `open_positions` (
  `id`                INT AUTO_INCREMENT PRIMARY KEY,
  `user_id`           INT           NOT NULL,
  `broker_config_id`  INT           NULL,
  `broker_name`       VARCHAR(80)   NULL,
  `broker_account_id` VARCHAR(80)   NULL,
  `symbol_token`      VARCHAR(30)   NULL,
  `trading_symbol`    VARCHAR(100)  NOT NULL,
  `exchange`          VARCHAR(10)   NULL,
  `product_type`      VARCHAR(20)   NULL,
  `net_qty`           INT           NOT NULL DEFAULT 0,
  `buy_avg`           DECIMAL(18,4) NOT NULL DEFAULT 0,
  `sell_avg`          DECIMAL(18,4) NOT NULL DEFAULT 0,
  `ltp`               DECIMAL(18,4) NOT NULL DEFAULT 0,
  `pnl`               DECIMAL(18,4) NOT NULL DEFAULT 0,
  `created_at`        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  -- One current row per instrument per user+account, so a re-dump updates in place.
  UNIQUE KEY `uniq_open_position` (`user_id`, `broker_config_id`, `trading_symbol`, `product_type`),
  KEY `idx_open_positions_user` (`user_id`),
  KEY `idx_open_positions_broker` (`broker_config_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- strategy_details: per-leg broker ownership.
--
-- The broker tag used to live only on strategy_master, i.e. on the GROUP, which
-- makes a group structurally single-account. The net-positions sync leans on
-- that directly - it only considers legs whose GROUP is tagged to the account
-- being synced - so a leg filed into another account's group silently stopped
-- being closed by its own account's sync. Nothing reported it, because the leg
-- was never matched in the first place.
--
-- Ownership therefore moves down to the leg: a leg is synced and priced by the
-- account it was actually traded on, whatever group it is filed under.
--
-- Reads go through COALESCE(leg, group), so legs left NULL keep answering with
-- their group's tag and behaviour is unchanged until a leg is stamped.
--
-- helpers/strategy_leg_broker.php applies this on demand too (and does the same
-- backfill), so this migration is the tracked, canonical definition; applying it
-- by hand is optional.

ALTER TABLE `strategy_details`
  ADD COLUMN `broker_config_id`  INT         NULL AFTER `strategy_code`,
  ADD COLUMN `broker_name`       VARCHAR(80) NULL AFTER `broker_config_id`,
  ADD COLUMN `broker_account_id` VARCHAR(80) NULL AFTER `broker_name`;

-- Seed from the group. Every existing leg was saved from its group's account, so
-- this is a faithful starting point. Run ONCE, at add-column time: re-running it
-- later would overwrite leg-level ownership with the group's tag, which is
-- exactly the bug this migration exists to fix.
UPDATE `strategy_details` d
  JOIN `strategy_master` m ON m.strategy_code = d.strategy_code
   SET d.broker_config_id  = m.broker_config_id,
       d.broker_name       = m.broker_name,
       d.broker_account_id = m.broker_account_id;

CREATE INDEX `idx_strategy_details_broker` ON `strategy_details` (`broker_config_id`);

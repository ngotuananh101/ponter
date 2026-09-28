CREATE INDEX `signals_session_created_idx` ON `signals` (`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `signals_expires_at_idx` ON `signals` (`expires_at`);
ALTER TABLE `agents` ADD `credential_hash` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `capabilities` text;--> statement-breakpoint
CREATE UNIQUE INDEX `agents_credential_hash_unique` ON `agents` (`credential_hash`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `started_at` text;
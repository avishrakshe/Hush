CREATE TABLE `desk_fills` (
	`quote_id` text PRIMARY KEY NOT NULL,
	`agent` text NOT NULL,
	`ticker` text NOT NULL,
	`side` text NOT NULL,
	`size` text NOT NULL,
	`price` text NOT NULL,
	`notional` text NOT NULL,
	`scheme` text NOT NULL,
	`filled_at` integer NOT NULL,
	`fill` text NOT NULL,
	`signature` text NOT NULL,
	`voucher_leaf` text,
	`payment_tx` text,
	`delivery_tx` text
);
--> statement-breakpoint
CREATE TABLE `desk_positions` (
	`agent` text NOT NULL,
	`ticker` text NOT NULL,
	`position` text NOT NULL,
	`avg_cost` text NOT NULL,
	`seq` integer NOT NULL,
	PRIMARY KEY(`agent`, `ticker`)
);
--> statement-breakpoint
CREATE TABLE `desk_quotes` (
	`quote_id` text PRIMARY KEY NOT NULL,
	`agent` text NOT NULL,
	`used_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `desk_settle_outs` (
	`request_id` text PRIMARY KEY NOT NULL,
	`agent` text NOT NULL,
	`ticker` text NOT NULL,
	`size` text NOT NULL,
	`avg_cost` text NOT NULL,
	`status` text NOT NULL,
	`tx_hash` text,
	`request` text NOT NULL,
	`signature` text NOT NULL,
	`created_at` integer NOT NULL,
	`executed_at` integer,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `desk_statements` (
	`agent` text NOT NULL,
	`seq` integer NOT NULL,
	`ticker` text NOT NULL,
	`position` text NOT NULL,
	`avg_cost` text NOT NULL,
	`reason` text NOT NULL,
	`statement` text NOT NULL,
	`signature` text NOT NULL,
	`issued_at` integer NOT NULL,
	PRIMARY KEY(`agent`, `seq`)
);
--> statement-breakpoint
ALTER TABLE `credits` ADD `proceeds_total` text DEFAULT '0' NOT NULL;
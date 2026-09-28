CREATE TABLE `batches` (
	`provider` text NOT NULL,
	`batch_id` text NOT NULL,
	`root` text NOT NULL,
	`tx_hash` text NOT NULL,
	`voucher_count` integer NOT NULL,
	`dummy` integer NOT NULL,
	`committed_at` integer NOT NULL,
	PRIMARY KEY(`provider`, `batch_id`)
);
--> statement-breakpoint
CREATE TABLE `credits` (
	`agent` text NOT NULL,
	`provider` text NOT NULL,
	`credited_total` text NOT NULL,
	`refunded_total` text NOT NULL,
	`settled_cumulative` text NOT NULL,
	`last_nonce` text NOT NULL,
	`last_top_up_at` integer,
	PRIMARY KEY(`agent`, `provider`)
);
--> statement-breakpoint
CREATE TABLE `direct_payments` (
	`tx_hash` text PRIMARY KEY NOT NULL,
	`agent` text NOT NULL,
	`provider` text NOT NULL,
	`amount` text NOT NULL,
	`resource` text NOT NULL,
	`settled_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `exact_payments` (
	`tx_hash` text PRIMARY KEY NOT NULL,
	`payer` text NOT NULL,
	`pay_to` text NOT NULL,
	`amount` text NOT NULL,
	`resource` text NOT NULL,
	`settled_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `refunds` (
	`id` text PRIMARY KEY NOT NULL,
	`agent` text NOT NULL,
	`provider` text NOT NULL,
	`amount` text NOT NULL,
	`tx_hash` text,
	`reason` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `top_ups` (
	`tx_hash` text PRIMARY KEY NOT NULL,
	`agent` text NOT NULL,
	`provider` text NOT NULL,
	`payer` text NOT NULL,
	`amount` text NOT NULL,
	`block_number` text NOT NULL,
	`receipt` text NOT NULL,
	`signature` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `vouchers` (
	`leaf` text PRIMARY KEY NOT NULL,
	`agent` text NOT NULL,
	`provider` text NOT NULL,
	`voucher` text NOT NULL,
	`signature` text NOT NULL,
	`amount` text NOT NULL,
	`resource` text NOT NULL,
	`settled_at` integer NOT NULL,
	`batch_id` text,
	`proof` text
);

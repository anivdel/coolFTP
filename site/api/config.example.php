<?php
// coolFTP license server configuration. This file is git-ignored and must never be deployed
// with real values anywhere but the server. Fill in each value between the quotes.
declare(strict_types=1);

// ---- Stripe (Dashboard > Developers) ----
define('STRIPE_WEBHOOK_SECRET', 'whsec_REPLACE_ME');            // Webhooks > your endpoint > Signing secret
define('STRIPE_RESTRICTED_KEY', 'rk_live_REPLACE_ME');           // API keys > Create restricted key: Checkout Sessions read, Customers read
define('STRIPE_PRICE_PRO', 'price_REPLACE_ME');                  // Product "coolFTP Pro" > the $49 price id
define('STRIPE_PRICE_RENEW', 'price_REPLACE_ME');                // Product "coolFTP Pro" > the renewal price id

// ---- License signing (from scripts/license/private/sodium-secret.txt on your PC) ----
define('LICENSE_SODIUM_SECRET_B64', 'REPLACE_ME');

// ---- Outgoing mail (the licenses@coolftp.com mailbox) ----
define('SMTP_HOST', 'smtp.hostinger.com');
define('SMTP_PORT', 465);
define('SMTP_USER', 'licenses@coolftp.com');
define('SMTP_PASS', 'REPLACE_ME');                              // the mailbox password
define('MAIL_FROM', 'licenses@coolftp.com');
define('MAIL_FROM_NAME', 'coolFTP');

// ---- Storage (outside the web root; created on first use) ----
define('LICENSE_DIR', __DIR__ . '/../../licenses');

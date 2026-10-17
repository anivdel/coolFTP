<?php
// Stripe webhook: on a paid Checkout Session, issue a coolFTP Pro license and email it.
// Configure the endpoint in Stripe as https://coolftp.com/api/stripe-webhook.php
// listening to the single event "checkout.session.completed".
declare(strict_types=1);
require_once __DIR__ . '/lib.php';

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') cf_json(405, ['error' => 'POST only']);

$payload = (string)file_get_contents('php://input');
$sigHeader = $_SERVER['HTTP_STRIPE_SIGNATURE'] ?? '';
if (!cf_stripe_verify($payload, $sigHeader, STRIPE_WEBHOOK_SECRET)) cf_json(400, ['error' => 'bad signature']);

$event = json_decode($payload, true);
if (!$event || empty($event['id']) || empty($event['type'])) cf_json(400, ['error' => 'bad event']);
if ($event['type'] !== 'checkout.session.completed') cf_json(200, ['ignored' => $event['type']]);

$session = $event['data']['object'] ?? [];
if (($session['payment_status'] ?? '') !== 'paid') cf_json(200, ['ignored' => 'not paid']);
if (!cf_mark_event($event['id'])) cf_json(200, ['ignored' => 'duplicate']);

$email = strtolower(trim((string)($session['customer_details']['email'] ?? $session['customer_email'] ?? '')));
if ($email === '') cf_json(200, ['ignored' => 'no email on session']);

// Pro is one payment with updates for life. The far-future updatesUntil keeps keys valid in
// builds released before updates stopped being time-limited, which still check the date.
$plan = 'pro';
$today = gmdate('Y-m-d');
$until = LIFETIME_UPDATES_UNTIL;

try {
    $lic = cf_make_license($email, $today, $until, 3);
} catch (Throwable $e) {
    error_log('license signing failed: ' . $e->getMessage());
    cf_json(500, ['error' => 'signing failed']);
}

cf_store_license([
    'id' => $lic['payload']['id'],
    'email' => $email,
    'plan' => $plan,
    'issued' => $today,
    'updatesUntil' => $until,
    'key' => $lic['key'],
    'stripe_session' => $session['id'] ?? null,
    'stripe_customer' => $session['customer'] ?? null,
    'amount_total' => $session['amount_total'] ?? null,
    'currency' => $session['currency'] ?? null,
    'event' => $event['id'],
    'at' => gmdate('c'),
]);

$sent = cf_send_mail($email, 'Your coolFTP Pro license key', cf_license_email_body($lic['key'], $lic['payload'], false));
if (!$sent) error_log("license email to $email failed; key stored, resend from https://coolftp.com/#pro");

cf_json(200, ['ok' => true, 'plan' => $plan, 'emailed' => $sent]);

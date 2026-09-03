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

// Which product? Prefer metadata set on the Payment Link (plan=pro | plan=renewal); else look at the price ids.
$plan = strtolower((string)($session['metadata']['plan'] ?? ''));
if ($plan === '') {
    try {
        $items = cf_stripe_get('checkout/sessions/' . rawurlencode($session['id']) . '/line_items');
        foreach ($items['data'] ?? [] as $li) {
            $price = $li['price']['id'] ?? '';
            if ($price === STRIPE_PRICE_RENEW) $plan = 'renewal';
            elseif ($price === STRIPE_PRICE_PRO) $plan = 'pro';
        }
    } catch (Throwable $e) {
        error_log('line_items lookup failed: ' . $e->getMessage());
    }
}
if ($plan === '') $plan = 'pro';

$today = gmdate('Y-m-d');
$start = $today;
if ($plan === 'renewal') {
    // Extend from the current updatesUntil when it is still in the future, never from before today.
    foreach (cf_find_licenses($email) as $r) {
        if (!empty($r['updatesUntil']) && $r['updatesUntil'] > $start) $start = $r['updatesUntil'];
    }
}
$until = gmdate('Y-m-d', strtotime($start . ' +365 days'));

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

$sent = cf_send_mail($email, $plan === 'renewal' ? 'Your coolFTP Pro renewal' : 'Your coolFTP Pro license key', cf_license_email_body($lic['key'], $lic['payload'], $plan === 'renewal'));
if (!$sent) error_log("license email to $email failed; key stored, resend from https://coolftp.com/#pro");

cf_json(200, ['ok' => true, 'plan' => $plan, 'emailed' => $sent]);

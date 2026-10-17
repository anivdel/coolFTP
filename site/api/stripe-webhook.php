<?php
// Stripe webhook: on a paid Checkout Session, issue a Pro license (coolFTP, OwlSQL, or a bundle) and email it.
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

// Which app? Set metadata product=owlsql (comma-separated for a bundle) on the Payment Link, or name
// the Stripe product after the app ("OwlSQL Pro"). Anything unrecognised is coolFTP, the first product.
$products = array_filter(array_map('trim', explode(',', strtolower((string)($session['metadata']['product'] ?? '')))));
if (!$products) {
    try {
        $items = cf_stripe_get('checkout/sessions/' . rawurlencode($session['id']) . '/line_items');
        foreach ($items['data'] ?? [] as $li) {
            $name = strtolower((string)($li['description'] ?? ''));
            foreach (array_keys(LS_PRODUCTS) as $p) if ($p !== 'coolftp' && strpos($name, $p) !== false) $products[] = $p;
        }
    } catch (Throwable $e) {
        error_log('line_items lookup failed: ' . $e->getMessage());
    }
}
$products = array_values(array_unique(array_intersect($products, array_keys(LS_PRODUCTS))));
if (!$products) $products = ['coolftp'];
$plan = 'pro';
$today = gmdate('Y-m-d');
$until = LIFETIME_UPDATES_UNTIL;

try {
    // coolFTP alone keeps its CFP1 key so it works in every coolFTP build; anything else is an LS1 key.
    // The far-future updatesUntil keeps CFP1 keys valid in builds that still check the date.
    $lic = $products === ['coolftp'] ? cf_make_license($email, $today, $until, 3) : cf_make_ls_license($email, $products, $today, 3);
} catch (Throwable $e) {
    error_log('license signing failed: ' . $e->getMessage());
    cf_json(500, ['error' => 'signing failed']);
}

cf_store_license([
    'id' => $lic['payload']['id'],
    'email' => $email,
    'plan' => $plan,
    'products' => $products,
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

$sent = cf_send_mail($email, 'Your ' . cf_products_label($products) . ' license key', cf_license_email_body([['key' => $lic['key'], 'products' => $products, 'seats' => 3]]));
if (!$sent) error_log("license email to $email failed; key stored, resend from https://coolftp.com/#pro");

cf_json(200, ['ok' => true, 'products' => $products, 'emailed' => $sent]);

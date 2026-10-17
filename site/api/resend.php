<?php
// "Lost my key" form: re-emails every license key for an address (coolFTP, OwlSQL, bundles). Always answers the same
// way so it cannot be used to check whether an address bought anything.
declare(strict_types=1);
require_once __DIR__ . '/lib.php';

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') cf_json(405, ['error' => 'POST only']);
if (!cf_rate_limit('resend', 5, 3600)) cf_json(429, ['error' => 'Too many requests. Try again in an hour.']);

$email = strtolower(trim((string)($_POST['email'] ?? '')));
if (!filter_var($email, FILTER_VALIDATE_EMAIL)) cf_json(400, ['error' => 'Enter a valid email address.']);

$records = cf_find_licenses($email);
if ($records) {
    $keys = [];
    foreach ($records as $r) $keys[$r['key']] = ['key' => $r['key'], 'products' => cf_record_products($r), 'seats' => 3];
    cf_send_mail($email, 'Your license keys', cf_license_email_body(array_values($keys), true));
}
cf_json(200, ['ok' => true, 'message' => 'If we have a license for that address, it has been sent.']);

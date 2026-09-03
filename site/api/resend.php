<?php
// "Lost my key" form: re-emails the newest license for an address. Always answers the same
// way so it cannot be used to check whether an address bought anything.
declare(strict_types=1);
require_once __DIR__ . '/lib.php';

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') cf_json(405, ['error' => 'POST only']);
if (!cf_rate_limit('resend', 5, 3600)) cf_json(429, ['error' => 'Too many requests. Try again in an hour.']);

$email = strtolower(trim((string)($_POST['email'] ?? '')));
if (!filter_var($email, FILTER_VALIDATE_EMAIL)) cf_json(400, ['error' => 'Enter a valid email address.']);

$records = cf_find_licenses($email);
if ($records) {
    $latest = end($records);
    $payload = ['seats' => 3, 'updatesUntil' => $latest['updatesUntil']];
    cf_send_mail($email, 'Your coolFTP Pro license key', cf_license_email_body($latest['key'], $payload, false));
}
cf_json(200, ['ok' => true, 'message' => 'If we have a license for that address, it has been sent.']);

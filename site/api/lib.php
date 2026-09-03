<?php
// Shared helpers for the coolFTP license endpoints. Requires config.php next to it.
declare(strict_types=1);

require_once __DIR__ . '/config.php';

function cf_json(int $status, array $body): void {
    http_response_code($status);
    header('Content-Type: application/json');
    echo json_encode($body);
    exit;
}

function cf_b64url(string $bin): string {
    return rtrim(strtr(base64_encode($bin), '+/', '-_'), '=');
}

/** Build and sign a license key. Mirrors packages/core/src/license.ts. */
function cf_make_license(string $email, string $issued, string $updatesUntil, int $seats = 3): array {
    $payload = [
        'v' => 1,
        'id' => bin2hex(random_bytes(5)),
        'email' => strtolower(trim($email)),
        'tier' => 'pro',
        'seats' => $seats,
        'issued' => $issued,
        'updatesUntil' => $updatesUntil,
    ];
    $body = cf_b64url(json_encode($payload, JSON_UNESCAPED_SLASHES));
    $secret = base64_decode(LICENSE_SODIUM_SECRET_B64, true);
    if ($secret === false || strlen($secret) !== SODIUM_CRYPTO_SIGN_SECRETKEYBYTES) {
        throw new RuntimeException('LICENSE_SODIUM_SECRET_B64 is not a valid 64-byte libsodium secret key');
    }
    $sig = sodium_crypto_sign_detached('CFP1.' . $body, $secret);
    return ['key' => 'CFP1.' . $body . '.' . cf_b64url($sig), 'payload' => $payload];
}

function cf_license_dir(): string {
    $dir = LICENSE_DIR;
    if (!is_dir($dir)) mkdir($dir, 0700, true);
    return rtrim($dir, '/');
}

/** Append a license record; one JSON object per line, outside the web root. */
function cf_store_license(array $record): void {
    $line = json_encode($record, JSON_UNESCAPED_SLASHES) . "\n";
    file_put_contents(cf_license_dir() . '/licenses.jsonl', $line, FILE_APPEND | LOCK_EX);
}

/** All records for an email, newest last. */
function cf_find_licenses(string $email): array {
    $file = cf_license_dir() . '/licenses.jsonl';
    if (!is_file($file)) return [];
    $email = strtolower(trim($email));
    $out = [];
    foreach (file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
        $r = json_decode($line, true);
        if ($r && isset($r['email']) && $r['email'] === $email) $out[] = $r;
    }
    return $out;
}

/** Idempotency for Stripe events: true the first time an id is seen. */
function cf_mark_event(string $id): bool {
    $file = cf_license_dir() . '/events.txt';
    $seen = is_file($file) ? file($file, FILE_IGNORE_NEW_LINES) : [];
    if (in_array($id, $seen, true)) return false;
    file_put_contents($file, $id . "\n", FILE_APPEND | LOCK_EX);
    return true;
}

/** Simple per-IP rate limit: allow $max hits per $window seconds. */
function cf_rate_limit(string $bucket, int $max, int $window): bool {
    $ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
    $file = cf_license_dir() . '/rate-' . $bucket . '-' . md5($ip) . '.json';
    $now = time();
    $hits = is_file($file) ? (json_decode((string)file_get_contents($file), true) ?: []) : [];
    $hits = array_values(array_filter($hits, fn($t) => $t > $now - $window));
    if (count($hits) >= $max) return false;
    $hits[] = $now;
    file_put_contents($file, json_encode($hits));
    return true;
}

/** Verify a Stripe-Signature header against the raw payload (v1 scheme, 5 minute tolerance). */
function cf_stripe_verify(string $payload, string $header, string $secret): bool {
    $parts = [];
    foreach (explode(',', $header) as $kv) {
        [$k, $v] = array_pad(explode('=', trim($kv), 2), 2, '');
        $parts[$k][] = $v;
    }
    $t = $parts['t'][0] ?? null;
    if (!$t || abs(time() - (int)$t) > 300) return false;
    $expected = hash_hmac('sha256', $t . '.' . $payload, $secret);
    foreach ($parts['v1'] ?? [] as $sig) if (hash_equals($expected, $sig)) return true;
    return false;
}

/** GET a Stripe API path with the restricted key. */
function cf_stripe_get(string $path): array {
    $ch = curl_init('https://api.stripe.com/v1/' . ltrim($path, '/'));
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . STRIPE_RESTRICTED_KEY],
        CURLOPT_TIMEOUT => 15,
    ]);
    $res = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($res === false || $code >= 400) throw new RuntimeException("Stripe API $path failed ($code)");
    return json_decode($res, true) ?: [];
}

/** Send mail through the licenses@ mailbox over SMTP (TLS), falling back to PHP mail(). */
function cf_send_mail(string $to, string $subject, string $body): bool {
    $from = MAIL_FROM;
    $fromName = MAIL_FROM_NAME;
    if (SMTP_HOST !== '' && SMTP_USER !== '' && SMTP_PASS !== '') {
        try {
            return cf_smtp_send($to, $subject, $body, $from, $fromName);
        } catch (Throwable $e) {
            error_log('SMTP failed, falling back to mail(): ' . $e->getMessage());
        }
    }
    $headers = "From: $fromName <$from>\r\nReply-To: $from\r\nContent-Type: text/plain; charset=UTF-8\r\n";
    return mail($to, $subject, $body, $headers);
}

function cf_smtp_send(string $to, string $subject, string $body, string $from, string $fromName): bool {
    $port = (int)SMTP_PORT;
    $transport = $port === 465 ? 'ssl://' : '';
    $sock = @stream_socket_client($transport . SMTP_HOST . ':' . $port, $errno, $errstr, 20);
    if (!$sock) throw new RuntimeException("connect: $errstr");
    $read = function () use ($sock): string {
        $data = '';
        while (($line = fgets($sock, 515)) !== false) {
            $data .= $line;
            if (strlen($line) < 4 || $line[3] !== '-') break;
        }
        return $data;
    };
    $cmd = function (string $c, array $ok) use ($sock, $read): string {
        fwrite($sock, $c . "\r\n");
        $r = $read();
        if (!in_array((int)substr($r, 0, 3), $ok, true)) throw new RuntimeException("$c -> $r");
        return $r;
    };
    $read();
    $cmd('EHLO coolftp.com', [250]);
    if ($port !== 465) {
        $cmd('STARTTLS', [220]);
        if (!stream_socket_enable_crypto($sock, true, STREAM_CRYPTO_METHOD_TLS_CLIENT)) throw new RuntimeException('STARTTLS failed');
        $cmd('EHLO coolftp.com', [250]);
    }
    $cmd('AUTH LOGIN', [334]);
    $cmd(base64_encode(SMTP_USER), [334]);
    $cmd(base64_encode(SMTP_PASS), [235]);
    $cmd("MAIL FROM:<$from>", [250]);
    $cmd("RCPT TO:<$to>", [250, 251]);
    $cmd('DATA', [354]);
    $headers = "From: $fromName <$from>\r\nTo: <$to>\r\nSubject: $subject\r\nDate: " . date('r') . "\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n";
    $msg = $headers . "\r\n" . str_replace("\n.", "\n..", $body) . "\r\n.";
    $cmd($msg, [250]);
    $cmd('QUIT', [221]);
    fclose($sock);
    return true;
}

function cf_license_email_body(string $key, array $payload, bool $renewal): string {
    $what = $renewal ? 'Your coolFTP Pro renewal is done.' : 'Thanks for buying coolFTP Pro.';
    return <<<TXT
$what

Your license key:

$key

Activate it once per machine (up to {$payload['seats']}):
  In the app: click Pro in the top bar, paste the key, Activate.
  Or:         coolftp license activate <key>

Pro features unlock in every coolFTP build released on or before {$payload['updatesUntil']}, and keep working in those builds forever. Builds released after that date run as Free until you renew.

Lost this email? Get the key re-sent at https://coolftp.com/#pro
Questions: reply to this message.

Justin Ledvina
coolFTP · https://coolftp.com
TXT;
}

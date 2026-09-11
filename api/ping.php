<?php
// Quick capability check for the hosting environment.
header('Content-Type: application/json');
echo json_encode([
  'ok' => true,
  'php' => PHP_VERSION,
  'pdo_mysql' => extension_loaded('pdo_mysql'),
  'home_writable' => is_writable(dirname($_SERVER['DOCUMENT_ROOT'])),
  'docroot_writable' => is_writable($_SERVER['DOCUMENT_ROOT']),
]);

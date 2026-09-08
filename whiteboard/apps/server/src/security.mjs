export function validateSecurityConfig({ host = '127.0.0.1', token = '' } = {}) {
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (!loopback && !token) throw new Error('WHITEBOARD_TOKEN must be set when HOST is not loopback');
  return true;
}

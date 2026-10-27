const endpoint = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export function fixtureCaptchaFetch(hostname, originalFetch = globalThis.fetch) {
  const used = new Set();
  return async (input, options = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== endpoint) return originalFetch(input, options);
    if (options.method !== 'POST' || options.redirect !== 'error') {
      throw new Error('Unexpected CAPTCHA provider request');
    }
    const body = new URLSearchParams(options.body);
    const token = body.get('response') ?? '';
    if (token === 'fixture-unavailable') throw new Error('Synthetic provider unavailable');
    const valid = /^fixture-valid-[0-9a-f-]{36}$/.test(token) && !used.has(token);
    if (valid) used.add(token);
    return Response.json({
      success: valid || token === 'fixture-wrong-action' || token === 'fixture-wrong-host',
      action: token === 'fixture-wrong-action' ? 'signup' : 'login',
      hostname: token === 'fixture-wrong-host' ? 'unrelated.invalid' : hostname,
    });
  };
}

if (process.env.ARTIFACT_INTEGRATION_CAPTCHA_HOST) {
  if (process.platform !== 'linux' || process.env.ARTIFACT_INTEGRATION_SYNTHETIC !== '1') {
    throw new Error('Synthetic provider requires the isolated Linux fixture');
  }
  globalThis.fetch = fixtureCaptchaFetch(process.env.ARTIFACT_INTEGRATION_CAPTCHA_HOST);
}

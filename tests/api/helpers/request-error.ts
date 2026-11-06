export function redactRequestFailure(failure: unknown) {
  const message = failure instanceof Error ? failure.message : String(failure);
  const redacted = message
    .replace(
      /(\b(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-umami-(?:share-token|cache|collection-permit|collection-key)):\s*)[^\r\n]+/gi,
      '$1[redacted]',
    )
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[redacted]@')
    .replace(
      /([?&](?:access_token|refresh_token|token|key|password|secret|code)=)[^&\s]+/gi,
      '$1[redacted]',
    )
    .replace(
      /("(?:password|currentPassword|newPassword|accessToken|refreshToken|token|secret|twoFactorCode|totp)"\s*:\s*)"(?:\\.|[^"\\])*"/gi,
      '$1"[redacted]"',
    );
  const error = new Error(redacted);
  if (failure instanceof Error && /^[A-Za-z][A-Za-z0-9]*Error$/.test(failure.name)) {
    error.name = failure.name;
  }
  return error;
}

export function isEnabled(value: string | null | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(value?.trim().toLowerCase() ?? '');
}

export function isEnvEnabled(name: string): boolean {
  return isEnabled(process.env[name]);
}

/**
 * Normalise an Indian mobile number to E.164 (+91XXXXXXXXXX).
 * Accepts "98765 43210", "098765-43210", "+91 98765 43210", "919876543210".
 * Launch is India-only; widen this (e.g. libphonenumber-js) when that changes.
 */
export function normalizeIndianMobile(input: string): string | null {
  const digits = input.replace(/[\s\-().]/g, '');
  let national: string | undefined;
  if (/^\+91\d{10}$/.test(digits)) national = digits.slice(3);
  else if (/^91\d{10}$/.test(digits)) national = digits.slice(2);
  else if (/^0\d{10}$/.test(digits)) national = digits.slice(1);
  else if (/^\d{10}$/.test(digits)) national = digits;
  if (!national || !/^[6-9]/.test(national)) return null;
  return `+91${national}`;
}

/** "+919876543210" -> "+91 ••••• •3210" for logs and staff screens. */
export function maskPhone(e164: string): string {
  return `${e164.slice(0, 3)} ••••• •${e164.slice(-4)}`;
}

// Cookie 工具（移植自 js/utils.js GMSUtils）

export function setCookie(name: string, value: string, days: number): void {
  const d = new Date();
  d.setTime(d.getTime() + days * 86400000);
  document.cookie = `${name}=${encodeURIComponent(value)};expires=${d.toUTCString()};path=/;SameSite=Lax`;
}

export function getCookie(name: string): string | null {
  const m = document.cookie.match('(^|;)\\s*' + name + '\\s*=\\s*([^;]+)');
  return m ? decodeURIComponent(m[2]) : null;
}

export function deleteCookie(name: string): void {
  document.cookie = `${name}=;expires=Thu,01 Jan 1970 00:00:00 UTC;path=/`;
}

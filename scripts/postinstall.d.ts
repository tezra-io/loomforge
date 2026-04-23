export function xmlEscape(value: string): string;
export function systemdQuote(value: string, options?: { escapeDollar?: boolean }): string;
export function daemonPath(): string;
export function findBin(name: string): string | null;

// ISO timestamps as datetime.fromisoformat reads them: evidence orders events by these instants.
import { pyStr } from './py-compat.mjs';

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2})(?::(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?(Z|[+-]\d{2}(?::?\d{2})?)?)?$/;

export interface Instant {
  /** Seconds since the epoch, as datetime.timestamp() gives them. */
  seconds: number;
  /** false for a naive value, which names no instant. */
  zoned: boolean;
}

export function parseIso(text: string): Instant {
  const match = ISO.exec(text);
  if (!match) throw new Error(`Invalid isoformat string: ${pyStr([text]).slice(1, -1)}`);
  const [, year, month, day, hour = '0', minute = '0', second = '0', fraction = '', zone] = match;
  const whole = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)) / 1000;
  const offset = !zone || zone === 'Z' ? 0
    : (zone.startsWith('-') ? -1 : 1) * (Number(zone.slice(1, 3)) * 3600 + Number(zone.slice(-2)) * 60 * Number(zone.length > 3));
  // Whole microseconds, then one division: the rounding of timedelta.total_seconds().
  const micros = (whole - offset) * 1_000_000 + Number(fraction.padEnd(6, '0').slice(0, 6));
  return { seconds: micros / 1_000_000, zoned: zone !== undefined };
}

/**
 * Parse a SQLite `datetime('now')` timestamp.
 *
 * SQLite emits UTC as "YYYY-MM-DD HH:MM:SS" — no 'T', no 'Z'. V8's fallback
 * parser reads that as LOCAL time, shifting every displayed timestamp by the
 * machine's UTC offset (on UTC-5, a message stored at 16:02 UTC rendered as
 * "04:02 PM" instead of 11:02 AM).
 *
 * NOTE: the stored format is intentionally left alone — `created_at` is sorted
 * lexicographically as TEXT (ORDER BY created_at in message.repository.ts), and
 * mixing ' ' and 'T' separators would sort every legacy row before every new row
 * regardless of date, scrambling history across an upgrade. Normalise on read,
 * never on write.
 */
export function parseDbTimestamp(value: string): Date {
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    return new Date(`${value.replace(' ', 'T')}Z`)
  }
  return new Date(value) // already ISO-8601 (JS-written rows)
}

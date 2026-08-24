// ---------- INPUT SANITIZATION ----------
// Strips HTML/script-relevant characters from user-supplied text before it
// is written to the DB. This is defense at the source: display-side escaping
// (frontend) is still required too, but this stops malicious markup from
// ever being stored in the first place — e.g. a stored-XSS name like
// `<img src=x onerror=...>` that would otherwise execute in the admin's
// browser the moment their user list renders.

// Removes angle brackets and a few other HTML-significant characters,
// collapses whitespace, and trims. Keeps normal name characters (letters,
// numbers, spaces, apostrophes, hyphens, periods) intact.
function sanitizeName(raw) {
  if (raw === null || raw === undefined) return '';
  let s = String(raw);

  // Strip anything that could open/close an HTML tag or attribute.
  s = s.replace(/[<>"'`]/g, '');

  // Collapse repeated whitespace, trim ends.
  s = s.replace(/\s+/g, ' ').trim();

  // Reasonable length cap.
  if (s.length > 100) s = s.slice(0, 100);

  return s;
}

// General-purpose plain-text sanitizer for other free-text fields
// (e.g. phone, remarks/notes) — same rules, no length assumptions baked in.
function sanitizeText(raw, maxLen = 500) {
  if (raw === null || raw === undefined) return '';
  let s = String(raw).replace(/[<>"'`]/g, '').trim();
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

module.exports = { sanitizeName, sanitizeText };

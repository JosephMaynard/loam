/**
 * Put text on the clipboard. `navigator.clipboard` exists only in a secure context, and a LOAM node is
 * usually plain HTTP on the LAN, so fall back to the old hidden-textarea + `execCommand("copy")` route.
 * Resolves true when a copy was made (as far as the browser reports).
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path.
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  // iOS Safari selects nothing in a readonly textarea from `select()` alone.
  area.setSelectionRange(0, area.value.length);
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

/** Small Markdown renderer for Golem's replies and wiki sections. Escapes
 *  everything first, then adds a safe subset of formatting. */
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export function mdToHtml(src: string) {
  return String(src || "").split("```").map((seg, n) => {
    if (n % 2) return `<pre class="cb"><code>${esc(seg.replace(/^[a-z0-9_-]*\n/i, "").replace(/\n$/, ""))}</code></pre>`;
    const inline = (t: string) => esc(t)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/__([^_]+)__/g, "<b>$1</b>")
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, "$1<i>$2</i>").replace(/(^|\W)_([^_\n]+)_(?=\W|$)/g, "$1<i>$2</i>")
      .replace(/~~([^~]+)~~/g, "<s>$1</s>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/\[\[([^\]]+)\]\]/g, '<span class="wl">$1</span>');
    let out = "", list: string | null = null;
    const close = () => { if (list) { out += `</${list}>`; list = null; } };
    for (const line of seg.split("\n")) {
      const h = line.match(/^(#{1,4})\s+(.*)/), ul = line.match(/^\s*[-*•]\s+(.*)/), ol = line.match(/^\s*(\d+)[.)]\s+(.*)/), q = line.match(/^>\s?(.*)/);
      if (ul) { if (list !== "ul") { close(); out += "<ul>"; list = "ul"; } out += `<li>${inline(ul[1])}</li>`; continue; }
      if (ol) { if (list !== "ol") { close(); out += "<ol>"; list = "ol"; } out += `<li>${inline(ol[2])}</li>`; continue; }
      close();
      if (h) out += `<div class="ch">${inline(h[2])}</div>`;
      else if (q) out += `<blockquote>${inline(q[1])}</blockquote>`;
      else if (/^\s*(---|\*\*\*)\s*$/.test(line)) out += "<hr>";
      else if (line.trim()) out += `<p>${inline(line)}</p>`;
    }
    close(); return out;
  }).join("");
}
export const Markdown = ({ text }: { text: string }) => <div className="mdc" dangerouslySetInnerHTML={{ __html: mdToHtml(text) }} />;

export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const TAG = /<[^>]+>/g;
const ENT: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#8211;": "–",
  "&#8217;": "'", "&nbsp;": " ",
};

export function stripHtml(s: string): string {
  return (s || "")
    .replace(TAG, "")
    .replace(/&[#a-z0-9]+;/gi, (m) => ENT[m] ?? m)
    .trim();
}

const MPN_RE = new RegExp(
  [
    "ESP32[-\\w]*", "ESP8266[-\\w]*", "ATmega\\d+[A-Z\\-]*", "ATtiny\\d+[A-Z\\-]*",
    "STM32[FLHGWU]\\w+", "LM\\d{2,4}[A-Z\\-]*", "NE555", "MAX\\d{3,4}[A-Z\\-]*",
    "MPU-?6050", "BME\\d{3}", "BMP\\d{3}", "nRF\\d{4,5}[-\\w]*", "CP210\\d",
    "CH340[A-Z]?",
  ].join("|"),
  "i",
);

/** Best-effort MPN from a title (WooCommerce sites rarely give a real one). */
export function guessMpn(title: string): string | null {
  const m = (title || "").match(MPN_RE);
  return m ? m[0].toUpperCase() : null;
}

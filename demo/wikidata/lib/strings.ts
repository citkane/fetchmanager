export const frmt = {
  bold: (text: string | number) => {
    return `\x1B[1m${text}\x1B[0m`;
  },

  dim: (text: string | number) => {
    return `\x1B[2m${text}\x1B[0m`;
  },

  braces_sqr: (text: string | number) => {
    return frmt.dim("[") + frmt.bold(text) + frmt.dim("]");
  },

  strip_ascii: (text: string) => {
    return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
  },

  lrg_num: (num: number) => {
    return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  },
};

export const undef = frmt.dim("no translation");

export function parse_html(str: string) {
  str = strip_html(str); //.replaceAll("&quot;", '"');
  str = decode_chars(str);
  str = decode_num_chars(str);
  return str;
}

function strip_html(str: string) {
  return str.replace(/<([a-zA-Z][\w:-]*)(\s[^>]*)?>[\s\S]*?<\/\1>/g, (m) => {
    return m.replace(/^[\s\S]*?>([\s\S]*?)<\/[a-zA-Z][\w:-]*>$/, "$1");
  });
}

function decode_num_chars(str: string) {
  return str.replace(/&#(x?[0-9a-fA-F]+);/g, (_, hex_dec) => {
    const code_point = hex_dec.toLowerCase().startsWith("x")
      ? parseInt(hex_dec.slice(1), 16)
      : parseInt(hex_dec, 10);
    if (!Number.isFinite(code_point)) return _;
    try {
      return String.fromCodePoint(code_point);
    } catch {
      return _;
    }
  });
}

function decode_chars(str: string): string {
  return str.replace(/&([A-Za-z][A-Za-z0-9]+);/g, (m, name: string) => {
    const key = String(name);
    return char_map[key] ?? m;
  });
}

const char_map: { [key: string]: string } = {
  quot: `"`,
  amp: "&",
  lt: "<",
  gt: ">",
  apos: `'`,
  nbsp: " ",
  iexcl: "¡",
  cent: "¢",
  pound: "£",
  curren: "¤",
  yen: "¥",
  brvbar: "¦",
  sect: "§",
  uml: "¨",
  copy: "©",
  ordf: "ª",
  laquo: "«",
  not: "¬",
  shy: "­",
  reg: "®",
  macr: "¯",
  deg: "°",
  plusmn: "±",
  sup2: "²",
  sup3: "³",
  acute: "´",
  micro: "µ",
  para: "¶",
  middot: "·",
  cedil: "¸",
  sup1: "¹",
  ordm: "º",
  raquo: "»",
  frac14: "¼",
  frac12: "½",
  frac34: "¾",
  iquest: "¿",
  ldquo: "“",
  rdquo: "”",
  rsquo: "’",
  lsquo: "‘",
  euro: "€",
  trade: "™",
};

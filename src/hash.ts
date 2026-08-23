export function hash(targets: fm.opts.target<fm.kind>[]) {
  /*
   * Copyright (C) 2026 Michael Jonker
   *
   * This program is free software: you can redistribute it and/or modify
   * it under the terms of the GNU General Public License as published by
   * the Free Software Foundation, either version 3 of the License, or
   * (at your option) any later version.
   *
   * This program is distributed in the hope that it will be useful,
   * but WITHOUT ANY WARRANTY; without even the implied warranty of
   * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
   * GNU General Public License for more details.
   *
   * You should have received a copy of the GNU General Public License
   * along with this program.  If not, see <https://www.gnu.org/licenses/>.
   */

  const target_keys = parse_targets(targets);
  const str = target_keys.join("");
  let h1 = 0;
  let i = 0;
  const len = str.length;
  const remainder = len & 3;
  const bytes = len - remainder;
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;

  while (i < bytes) {
    let k1 =
      (str.charCodeAt(i) & 0xff) |
      ((str.charCodeAt(i + 1) & 0xff) << 8) |
      ((str.charCodeAt(i + 2) & 0xff) << 16) |
      ((str.charCodeAt(i + 3) & 0xff) << 24);

    k1 = Math.imul(k1, c1);
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = Math.imul(k1, c2);

    h1 ^= k1;
    h1 = (h1 << 13) | (h1 >>> 19);
    h1 = Math.imul(h1, 5) + 0xe6546b64;

    i += 4;
  }

  let k1 = 0;
  if (remainder === 3) k1 ^= (str.charCodeAt(i + 2) & 0xff) << 16;
  if (remainder >= 2) k1 ^= (str.charCodeAt(i + 1) & 0xff) << 8;
  if (remainder >= 1) {
    k1 ^= str.charCodeAt(i) & 0xff;
    k1 = Math.imul(k1, c1);
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = Math.imul(k1, c2);
    h1 ^= k1;
  }

  h1 ^= len;
  h1 ^= h1 >>> 16;
  h1 = Math.imul(h1, 0x85ebca6b);
  h1 ^= h1 >>> 13;
  h1 = Math.imul(h1, 0xc2b2ae35);
  h1 ^= h1 >>> 16;

  const uid = (h1 >>> 0).toString(16).padStart(8, "0");
  return { target_keys, uid };
}

function parse_targets(targets: fm.opts.target<fm.kind>[]) {
  const targ_strings = targets
    .map((targ) => (typeof targ === "string" ? targ : targ.target_key))
    .map((targ) => {
      targ = targ.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
      const { host, pathname } = new URL("any://" + targ);
      return pathname ? host + pathname : host;
    });
  return [...new Set(targ_strings)].sort((a, b) => b.length - a.length);
}

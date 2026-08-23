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

import readline from "node:readline/promises";
import { exec } from "node:child_process";
import * as str from "./strings";
import { Cache } from "./Cache";
import { type w } from "./wiki_types";
import type { explore, explore_result, definitions, search } from "..";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});
const cache = new Cache();
let no_log = false;

export class Tui {
  constructor(
    private i_search: search,
    private i_explore: explore,
    private i_definitions: definitions,
  ) {
    process.stdout.on("resize", () => {
      this.layout.resize();
    });
  }

  public init_query = () => {
    const { print, page, init_query, layout } = this;
    layout.set_resize(() => {});

    console.clear();
    print.header("Welcome to the Wiki structured data explorer.");
    rl.question(`What's your query?\n`)
      .then(page.search)
      .catch((err) => {
        console.error(err);
        init_query();
      });
  };

  public log = (mssg: string[]) => {
    if (no_log) return;

    const width = this.layout.screen_width();
    let mssg_str = mssg.join(" | ");
    mssg_str = mssg_str.length > width ? mssg_str.slice(0, width) : mssg_str;
    process.stdout.write(`${mssg_str}\r`);
  };
  private search = async (
    term: string,
    limit: number,
    next?: w.resp.search["continue"],
  ) => {
    const start = next ? next.sroffset : 0;
    const end = start + limit;
    const cache_res = cache.get.search(term, start, end);
    if (cache_res) return cache_res;

    const res = await this.i_search(term, limit, next);
    cache.set.search(term, start, end, res);
    return res;
  };

  private explore = async (topic: string) => {
    const cache_res = cache.get.explore(topic);
    if (cache_res) return cache_res;

    const res = await this.i_explore(topic);
    cache.set.explore(topic, res);
    return res;
  };

  definitions = async (ids: string[]) => {
    const cached_res = cache.get.definitions(ids);
    const cached_ids = Object.keys(cached_res);
    ids = ids.filter((id) => !cached_ids.includes(id));
    if (!ids.length) return cached_res;

    const res = await this.i_definitions(ids);
    cache.set.definitions(res);
    return { ...res, ...cached_res };
  };

  private links = {
    open: (url: string): Promise<boolean> => {
      url = new URL(url).toString();
      let command: string;
      switch (process.platform) {
        case "darwin":
          command = `open "${url}"`;
          break;
        case "win32":
          command = `start "" "${url}"`;
          break;
        default:
          command = `xdg-open "${url}"`;
      }
      return new Promise((res, rej) => {
        const to = setTimeout(() => {
          console.log(`Opened ${url} in your browser`);
          res(true);
        }, 800);
        exec(command, (err) => {
          if (!err) return;
          clearTimeout(to);
          rej(`Could not open browser: ${err.code} - ${err.message}`);
        });
      });
    },

    route: async (claim: w.frmtd.claim, def: w.frmtd.def): Promise<boolean> => {
      const { links } = this;
      let label = claim.label as keyof typeof links;
      if (links[label]) return links[label]!(claim as any, def);

      label = def.label as keyof typeof links;
      if (links[label]) return links[label]!(claim as any, def);

      return false;
    },

    commonsMedia: (claim: w.frmtd.claim, _def: w.frmtd.def) => {
      const { links } = this;
      const file = claim.description.replaceAll(" ", "_");
      const url = `https://commons.wikimedia.org/wiki/File:${file}`;
      return links.open(url);
    },

    url: (claim: w.frmtd.claim, _def: w.frmtd.def) => {
      const { links } = this;
      return links.open(claim.description);
    },

    "Commons category": (claim: w.frmtd.claim, _def: w.frmtd.def) => {
      const { links } = this;
      const file = claim.description.replaceAll(" ", "_");
      const url = `https://commons.wikimedia.org/wiki/Category:${file}`;
      return links.open(url);
    },

    "Commons gallery": (claim: w.frmtd.claim, _def: w.frmtd.def) => {
      const { links } = this;
      const file = claim.description.replaceAll(" ", "_");
      const url = `https://commons.wikimedia.org/wiki/${file}`;
      return links.open(url);
    },

    "external-id": (claim: w.frmtd.claim, def: w.frmtd.def) => {
      const { links } = this;
      const q1 = def.label;
      const q2 = claim.description;
      const url = `https://duckduckgo.com?q=${q1} ${q2}&ia=web&assist=true`;
      //https://duckduckgo.com/?t=ffab&q=ISNI+0000000109201253&ia=web&assist=true
      return links.open(url);
    },
  };

  private exit = () => {
    console.clear();
    process.exit(0);
  };

  private page = {
    search: async (
      term: string,
      limit = 20,
      next?: w.resp.search["continue"],
    ) => {
      const { search, page, explore, print, layout } = this;
      const back = () => page.search(term, limit);
      layout.set_resize(() => {
        back();
        menu();
      });

      const search_result = await search(term, limit, next);
      const search_data = Array.isArray(search_result)
        ? search_result
        : search_result.query.search;
      const { continue: cont, query } = search_result as w.resp.search;
      const index = next?.sroffset || 0;
      const total_len = query?.searchinfo?.totalhits || 0;
      const rem = Math.max(0, total_len - (index + limit));

      console.clear();
      const header_index = `[${index} - ${index + limit}]`;
      const header_len = `${str.frmt.lrg_num(total_len)}`;
      print.header(
        `Showing ${header_index} of (${header_len}) results for "${term}"`,
      );
      search_data.forEach((result, i) => {
        let { title: qid, snippet } = result;
        snippet = snippet === "" ? "undefined" : snippet;
        print.numbered_line(i, snippet, qid);
      });
      if (rem) print.more(rem, true);

      const cb = async (i: number | "n" | "p") => {
        if (i === "n")
          return page.search(term, limit, cont).then(() => {
            if (!next) cache.set.history(back);
          });
        if (i === "p") {
          next!.sroffset = index - limit;
          return page.search(term, limit, next!);
        }

        const qid = search_data[i]!.title;
        const cached_explore = cache.get.explore(qid);
        return (
          cached_explore
            ? page.explore(cached_explore)
            : explore(qid).then(page.explore)
        )
          .then(() => cache.set.history(back))
          .catch((err) => {
            console.error(err);
            print.menu(cb, limit, rem, index);
          });
      };
      menu();

      function menu() {
        print.menu(cb, limit, rem, index);
      }
    },

    explore: async (explore_result: explore_result, limit = 10, index = 0) => {
      const { print, page, explore, links, layout } = this;
      const { claims_entity, props_entity } = explore_result;
      const { description, label, qid } = claims_entity;

      const back = async () => page.explore(await explore(qid), limit, index);
      layout.set_resize(() => {
        back();
        menu();
      });

      const all_pids = Object.keys(props_entity);
      const size = all_pids.length;
      const rem = Math.max(0, size - (index + limit));
      const last_index = rem ? index + limit : size;
      const pids = all_pids.slice(index, last_index);

      console.clear();
      const header = `${label}: ${description} ${str.frmt.dim(`(${qid})`)}`;
      print.header(header);
      for (let i = 0; i < pids.length; i++) {
        const pid = pids[i]!;
        const prop = props_entity[pid]!;
        const claims = claims_entity.claims[pid]!;
        const text = `${prop.label}`;
        print.numbered_line(i, text, pid);
        await print.claims(claims);
      }

      if (rem) print.more(rem, true);

      const cb = async (i: number | "n" | "p") => {
        if (i === "n")
          return page
            .explore(explore_result, limit, index + limit)
            .then(() => {
              if (!index) cache.set.history(back);
            })
            .catch(handle_err);
        if (i === "p")
          return page.explore(explore_result, limit, index - limit);

        const pid = pids[i]!;
        const def = explore_result.props_entity[pid]!;
        const claims = explore_result.claims_entity.claims[pid]!;
        if (!claims || !claims.length) return menu();

        const qual_len = claims[0]!.qualifiers_order.length;
        const is_lone = claims.length === 1 && !qual_len;

        if (!is_lone)
          return page
            .claims(def, claims, qid, header)
            .then(() => cache.set.history(back))
            .catch(handle_err);

        const claim = claims[0]!;
        const id = claim.wiki ? claim.description : undefined;

        if (id)
          return explore(id)
            .then(page.explore)
            .then(() => cache.set.history(back))
            .catch(handle_err);
        if (await links.route(claim, def)) return menu();

        console.warn("No further links for this topic, choose again");
        return menu();
      };
      menu();

      function menu() {
        print.menu(cb, limit, rem, index);
      }

      function handle_err(err: any) {
        console.error(err);
        print.menu(cb, limit, rem, index);
      }
    },

    claims: async (
      def: w.frmtd.def,
      claims: w.frmtd.claim[],
      qid: string,
      parent_header: string,
    ) => {
      const { print, page, explore, links, layout } = this;
      const { label, id } = def;
      const back = async () => {
        const explore_result = await explore(qid);
        const prop = explore_result.props_entity[id]!;
        const claims = explore_result.claims_entity.claims[id]!;
        page.claims(prop, claims, qid, parent_header);
      };
      layout.set_resize(() => {
        back();
        menu();
      });

      const header = `${parent_header}\n${label} ${str.frmt.dim(`(${id})`)}`;

      console.clear();
      print.header(header);
      await print.claims(claims, claims.length, true).catch(handle_err);

      const cb = async (i: number | "n" | "p") => {
        if (i === "n") return;
        if (i === "p") return;

        const qid = claims[i]!.wiki ? claims[i]!.description : undefined;
        if (qid)
          return explore(qid)
            .then(page.explore)
            .then(() => cache.set.history(back))
            .catch(handle_err);

        const claim = claims[i]!;
        if (await links.route(claim, def)) return menu();

        console.warn("This item does not have a WikiData link, choose again");
        return menu();
      };
      menu();

      function menu() {
        print.menu(cb, claims.length, 0, 0);
      }

      function handle_err(err: any) {
        console.error(err);
        print.menu(cb, claims.length, 0, 0);
      }
    },
  };

  private layout = {
    resize: () => {
      const { resize_cb } = this;
      this.resize_to = setTimeout(() => {
        clearTimeout(this.resize_to);
        resize_cb();
      }, 300);
    },

    set_resize: (cb: () => void) => {
      this.resize_cb = cb;
    },

    tabs: (prefix = "-", len = 4) => {
      return " ".repeat(len) + prefix;
    },

    fit_line: (text: string, ...other: (string | undefined)[]) => {
      // Assumes 1 column width characters. Breaks with extra wide characters.
      const { layout } = this;
      text = str.parse_html(text);
      const width = layout.screen_width();
      if (!width) return text;

      other = other.filter((s) => s !== undefined);
      const all_text = str.frmt.strip_ascii([text, ...other].join(" "));
      const overflow = width - all_text.length;
      if (overflow >= 0) return text;

      text = text.slice(0, overflow - 3) + "...";
      return text;
    },

    line: () => {
      const { layout } = this;
      const len = layout.screen_width();
      return "-".repeat(len) + "\n";
    },

    screen_width: () => {
      return process.stdout.columns || 80;
    },

    center: (text: string) => {
      const { layout } = this;
      const left_pad = Math.floor(
        (layout.screen_width() - str.frmt.strip_ascii(text).length) / 2,
      );
      if (left_pad < 0) return text;

      return " ".repeat(left_pad) + text;
    },

    spacing: (items: string[]) => {
      const { layout } = this;
      const width = layout.screen_width();
      if (!width) return ", ";

      const content_width = str.frmt.strip_ascii(items.join("")).length;
      const spaces = Math.floor((width - content_width) / items.length);
      if (spaces < 4) return ", ";

      return " ".repeat(spaces);
    },
  };

  private print = {
    clear_log: () => {
      const width = process.stdout.columns || 80;
      process.stdout.write(`${" ".repeat(width)}\r`);
    },

    claims: async (claims: w.frmtd.claim[], limit = 2, det = false) => {
      const { print, definitions } = this;
      const claims_batch =
        claims.length > limit ? claims.slice(0, limit) : claims;
      const ids = claims_batch.filter((c) => c.wiki).map((c) => c.description!);
      const val_defs = claims_batch.filter((c) => !c.wiki);
      const wiki_defs = await definitions(ids);

      const claim_vals = [...Object.values(wiki_defs), ...val_defs];
      for (let i = 0; i < claim_vals.length; i++) {
        const claim_def = claim_vals[i]!;
        const claim = claims_batch[i];
        const qual_order = claim?.qualifiers_order;
        const qual_len = qual_order?.length;
        const is_wiki = !Object.hasOwn(claim_def, "wiki");
        let { id, description, label } = claim_def;
        description = await print.line_links(description);
        const _id = is_wiki ? id : undefined;

        const text = `${label}: ${description}`;
        det ? print.numbered_line(i, text, _id) : print.indent_line(text, _id);
        if (qual_len && !det) print.more_tabbed(qual_len!, "qualifiers");
        if (qual_len && det) await print.qualifiers(claim!);
      }

      const rem = claims.length - claims_batch.length;
      if (rem > 0) print.more_tabbed(rem);
    },

    qualifiers: async (claim: w.frmtd.claim) => {
      const { definitions, print } = this;
      const { qualifiers, qualifiers_order } = claim;
      const ids: string[] = [];
      Object.entries(qualifiers).forEach(([pid, qualifier]) => {
        if (qualifier.wiki) ids.push(qualifier.wiki);
        ids.push(pid);
      });
      const defs = await definitions(ids);

      for (let i = 0; i < qualifiers_order.length; i++) {
        const pid = qualifiers_order[i]!;
        const qualifier = qualifiers[pid]!;
        const { wiki, val } = qualifier;
        const label = defs[pid]!.label;
        let text = wiki ? defs[wiki]!.label : val!;
        text = await print.line_links(text);
        print.indent_line(`${label}: ${text}`);
      }
    },

    menu: (
      callback: (selection: number | "n" | "p") => void,
      limit: number,
      rem: number,
      index: number,
    ) => {
      const { layout, print, exit } = this;
      const next = rem > limit ? limit : rem;

      setTimeout(() => {
        const history = cache.get.history();
        const options = [];

        if (history) options.push(`${b("b")} back`);
        options.push(`${b("#")} explore topic`);
        if (rem) options.push(`${b("n")} next ${next} results`);
        if (index) options.push(`${b("p")} previous ${limit} results`);
        options.push(`${b("s")} new search`);
        options.push(`${b("q")} quit`);

        let menu = options.join(layout.spacing(options));
        menu = layout.line() + `${layout.center(menu)}\n` + layout.line();

        print.clear_log();
        rl.question(`\n${menu}`).then((opt) => {
          if (opt === "q") exit();
          if (opt === "n" && rem) return callback(opt);
          if (opt === "p" && index) return callback(opt);
          if (opt === "b" && history) return cache.back();
          if (opt === "s") return this.init_query();

          const selection = Number(opt);
          if (
            Number.isNaN(selection) ||
            selection < 0 ||
            selection > limit - 1
          ) {
            console.error(`[${opt}] is not valid. Try again.`);
            return print.menu(callback, limit, rem, index);
          }

          callback(selection);
        });
      });

      function b(val: string) {
        return str.frmt.braces_sqr(val);
      }
    },

    header: (mssg: string) => {
      const { layout, print } = this;
      print.clear_log();
      console.log(`\n${mssg}\n${layout.line()}`);
    },

    numbered_line: (i: number, text: string, id?: string) => {
      const { layout, print } = this;
      const num = str.frmt.braces_sqr(i);
      const wid = id ? str.frmt.dim(` (${id})`) : "";
      text = layout.fit_line(text, num, wid);
      print.clear_log();
      console.log(`\n${num} ${text}${wid}`);
    },

    indent_line: (text: string, id?: string, prefix = "- ") => {
      const { layout, print } = this;
      const wid = id ? str.frmt.dim(` (${id})`) : "";
      const tabs = layout.tabs(prefix);
      text = layout.fit_line(text, tabs, wid);
      print.clear_log();
      console.log(`${tabs}${text}${wid}`);
    },

    more: (more: number, newline = false) => {
      const { print } = this;
      print.clear_log();
      console.log(`${newline ? "\n" : ""}+ (${str.frmt.lrg_num(more)}) more`);
    },

    more_tabbed: (more: number, text = "more") => {
      const { layout, print } = this;
      print.clear_log();
      console.log(`${layout.tabs("+")} (${str.frmt.lrg_num(more)}) ${text}`);
    },

    line_links: async (line: string) => {
      const { definitions } = this;
      const regex = /(https?:\/\/[^\s,]+|www\.[^\s,]+)/gi;
      const urls = line.match(regex);
      if (!urls) return line;

      const matches = {} as { [url: string]: string };
      for (let i = 0; i < urls.length; i++) {
        const url = urls[i]!;
        const id = url.split("/").pop();
        if (!id || (!id.startsWith("P") && !id.startsWith("Q"))) break;

        matches[url] = id;
      }
      const defs = await definitions(Object.values(matches));
      Object.entries(matches).forEach(([url, id]) => {
        const label = defs[id]?.label || str.undef;
        line = line.replace(url, label);
      });

      return line;
    },
  };
  private resize_cb = () => {};
  private resize_to: any = null;
}

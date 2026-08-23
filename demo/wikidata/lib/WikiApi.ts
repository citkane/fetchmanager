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

import type { w } from "./wiki_types";
import * as str from "./strings";

export class WikiApi {
  constructor(private lang: string) {}

  public search = (
    term: string,
    limit = 50,
    next?: w.resp.search["continue"],
    ...statements: string[]
  ) => {
    const { headers, api } = this;
    const url = new URL(api.action);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 8000);

    url.search = params();
    if (next)
      Object.entries(next).forEach(([key, val]) =>
        url.searchParams.set(key, String(val)),
      );
    return new Request(url, { headers, signal: controller.signal });

    function params() {
      const _statements = statements
        .map((s) => `haswbstatement:${s}`)
        .join(" ");
      return new URLSearchParams({
        action: "query",
        list: "search",
        format: "json",
        srlimit: String(limit),
        srsearch: `${term} ${_statements}`,
        origin: "*",
      }).toString();
    }
  };

  public explore = (topic: string) => {
    const { headers, api } = this;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 8000);
    const url = new URL(`${api.entity}/${topic}.json`);
    return new Request(url, { headers, signal: controller.signal });
  };

  public definitions = (ids: string[], limit = 50) => {
    const { frmt, api, headers } = this;
    const batches = frmt.batch_ids(ids, limit);
    return batches.map(props);

    function props(props: string[]) {
      const url = new URL(api.action);
      url.searchParams.set("action", "wbgetentities");
      url.searchParams.set("ids", props.join("|"));
      url.searchParams.set("format", "json");
      url.searchParams.set("props", "labels|descriptions");

      return new Request(url, { headers });
    }
  };

  public merge_definitions = (batches: w.resp.defs["entities"][]) => {
    const definitions = {} as w.resp.defs["entities"];
    return batches.reduce((defs, batch) => {
      defs = { ...defs, ...batch };
      return defs;
    }, definitions);
  };

  public claims_entity = (
    entities: w.resp.explore["entities"],
    qid: string,
  ): w.frmtd.claims_entity | undefined => {
    const { prune, frmt } = this;
    const entity = entities[qid]!;
    const { descriptions, labels, aliases } = entity;
    const description = frmt.lang_val(descriptions) || str.undef;
    const label =
      frmt.lang_val(labels) || frmt.lang_alias_val(aliases) || str.undef;

    const claims = prune.claims(entity.claims);
    return { qid, description, label, claims };
  };

  public defs_entity = (entities: w.resp.defs["entities"]) => {
    const { frmt } = this;
    const definitions = {} as w.frmtd.defs_entity;
    Object.entries(entities)
      .sort(([a], [b]) => to_num(a) - to_num(b))
      .reduce((entities, [pid, prop]) => {
        const { labels, descriptions } = prop;
        const description = frmt.lang_val(descriptions) || str.undef;
        const label = frmt.lang_val(labels) || str.undef;
        entities[pid] = { description, label, id: pid };
        return entities;
      }, definitions);
    return definitions;

    function to_num(pid: string) {
      return Number(pid.replace("P", ""));
    }
  };

  private prune = {
    claims: (claims: w.resp.expl_entity["claims"]) => {
      const { prune } = this;
      const frmtd_claims = {} as { [qid: string]: w.frmtd.claim[] };

      Object.entries(claims).forEach(([qid, claim_array]) => {
        frmtd_claims[qid] = validate_claims(
          claim_array.map((claim) => prune.claim(claim)),
        );
      });
      return frmtd_claims;

      function validate_claims(claim_array: w.frmtd.claim[]) {
        return claim_array.filter(claim_filter).sort(claim_sort);
      }

      function claim_filter(c: w.frmtd.claim) {
        return c.rank !== "deprecated";
      }

      function claim_sort(a: w.frmtd.claim, b: w.frmtd.claim) {
        const num_a = a.rank === "preferred" ? 1 : 0;
        const num_b = b.rank === "preferred" ? 1 : 0;
        return num_b - num_a;
      }
    },

    claim: (claim: w.claim): w.frmtd.claim => {
      const { frmt } = this;
      const wiki = frmt.is_wiki_snak(claim.mainsnak);
      const description = frmt.snak(claim.mainsnak);
      const label = claim.mainsnak.datatype; //claim.mainsnak.datavalue?.type || claim.mainsnak.datatype;
      const claim_qualifiers = Object.values(claim.qualifiers || {}).flat();
      const qualifiers = frmt.snaks(claim_qualifiers);
      const claim_q_order = claim["qualifiers-order"] || [];
      const qualifiers_order = claim_q_order.filter((pid) => !!qualifiers[pid]);
      const rank = claim.rank;
      const id = claim.id;

      return {
        id,
        wiki,
        description,
        label,
        qualifiers,
        qualifiers_order,
        rank,
      };
    },
  };

  private frmt = {
    batch_ids: (
      array: string[],
      size: number,
      collect = [] as string[][],
    ): string[][] => {
      const { frmt } = this;
      if (array.length <= size && !collect.length) return [array];
      if (array.length <= size) return [...collect, array];

      const batch = array.splice(0, size - 1);
      collect.push(batch);
      return frmt.batch_ids(array, size, collect);
    },

    is_wiki_snak: (snak: w.snak) => {
      return (
        ["wikibase-item"].includes(snak.datatype) && snak.datavalue?.value.id
      );
    },

    snaks: (snaks: w.snak[]) => {
      const { frmt } = this;
      const cat_snaks = {} as w.frmtd.claim["qualifiers"];
      snaks.forEach((snak) => {
        const { property } = snak;
        cat_snaks[property] ??= {};
        const snak_string = frmt.snak(snak);
        if (!snak_string) return;

        const is_wiki = frmt.is_wiki_snak(snak);
        cat_snaks[property]!.wiki = is_wiki ? snak_string : undefined;
        cat_snaks[property]!.val = is_wiki ? undefined : snak_string;
      });
      return cat_snaks;
    },

    snak: (snak: w.snak): string => {
      const { frmt } = this;
      if (!snak.datavalue?.value) return str.undef;
      if (frmt.is_wiki_snak(snak)) return snak.datavalue.value.id;

      const { type } = snak.datavalue;
      if (Array.isArray(snak.datavalue.value))
        return snak.datavalue.value
          .map((val: any) =>
            typeof val === "object" ? JSON.stringify(val) : String(val),
          )
          .join(", ");

      if (typeof snak.datavalue.value === "object")
        return Object.entries(snak.datavalue.value)
          .map(([key, val], i) => {
            if (!i && type.endsWith(key)) return str.frmt.bold(String(val));
            if (!i && type === "quantity" && key === "amount")
              return str.frmt.bold(String(val));
            key = `${str.frmt.dim(key)}:`;
            return `${key} ${val}`;
          })
          .join(", ");

      return String(snak.datavalue.value);
    },

    lang_alias_val: (vals: { [lang: string]: w.lang_val[] }) => {
      const { lang } = this;
      if (vals[lang]?.[0]?.value) return vals[lang]![0]!.value;
      if (vals["mul"]?.[0]?.value) return vals["mull"]![0]!.value;

      const _lang = Object.keys(vals).find((key) => key.startsWith(`${lang}-`));
      if (_lang && vals[_lang]?.[0]?.value) return vals[_lang]![0]!.value;

      const label = Object.values(vals)[0]?.[0]?.value;
      return label ? `${label} (no ${lang})` : str.undef;
    },

    lang_val: (vals: { [lang: string]: w.lang_val }) => {
      const { lang } = this;
      if (vals[lang]?.value) return vals[lang]?.value;
      if (vals["mul"]?.value) return vals["mul"]?.value;

      let _lang = Object.keys(vals).find((key) => key.startsWith(`${lang}-`));
      if (_lang && vals[_lang]?.value) return vals[_lang]?.value;
    },
  };

  private api = {
    action: "https://www.wikidata.org/w/api.php",
    entity: "https://www.wikidata.org/wiki/Special:EntityData",
  };
  private headers = new Headers({
    "User-Agent":
      "fetchmanager/0.0 (https://github.com/citkane/fetchmanager/; noop@noop.com)",
  });
}

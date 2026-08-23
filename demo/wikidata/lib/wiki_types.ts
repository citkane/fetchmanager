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

export namespace w {
  export type search_res = w.resp.search | w.resp.search["query"]["search"];

  export namespace frmtd {
    export type claims_entity = {
      qid: string;
      description: string;
      label: string;
      claims: { [qid: string]: claim[] };
    };
    export type claim = {
      id: string;
      wiki: boolean;
      description: string;
      label: string;
      qualifiers: {
        [id: string]: { wiki?: string; val?: string };
      };
      qualifiers_order: string[];
      rank: string;
    };
    export type defs_entity = { [id: string]: def };
    export type def = {
      id: string;
      description: string;
      label: string;
    };
  }

  export namespace resp {
    export type search = {
      batchcomplete: string;
      continue?: {
        sroffset: number;
        continue: string;
      };
      query: {
        searchinfo?: {
          totalhits: number;
        };
        search: {
          ns: number;
          title: string;
          pageid: number;
          size: null;
          wordcount: number;
          snippet: string;
          timestamp: string;
        }[];
      };
    };
    export type defs = {
      entities: {
        [pid: string]: def_entity;
      };
    };

    export type def_entity = {
      type: "property";
      datatype: "wikibase-item";
      id: string;
      labels: { [lang: string]: lang_val };
      descriptions: { [lang: string]: lang_val };
    };

    export type explore = {
      entities: {
        [qid: string]: expl_entity;
      };
    };

    export type expl_entity = {
      pageid: number;
      ns: number;
      title: string;
      lastrevid: number;
      modified: string;
      type: string;
      id: string;
      labels: { [lang: string]: lang_val };
      descriptions: { [key: string]: lang_val };
      aliases: { [key: string]: lang_val[] };
      claims: { [prop: string]: claim[] };
      sitelinks: { [key: string]: sitelink[] };
    };
  }
  type datatypes =
    | "wikibase-item"
    | "wikibase-property"
    | "wikibase-lexeme"
    | "wikibase-sense"
    | "wikibase-form"
    | "wikibase-variant"
    | "entity-schema"
    | "wikibase-entityid"
    | "monolingualtext"
    | "string"
    | "external-id"
    | "url"
    | "commonsMedia"
    | "geo-shape";

  export type lang_val = { language: string; value: string };
  export type sitelink = { site: string; title: string; badges: [] };
  export type snak = {
    snaktype: "value" | "somevalue" | "novalue";
    property: string;
    hash: string;
    datavalue?: { value: any; type: string };
    datatype: datatypes;
  };
  export type claim = {
    mainsnak: snak;
    type: string;
    qualifiers?: {
      [prop: string]: snak[];
    };
    "qualifiers-order"?: string[];
    id: string;
    rank: "normal" | "preferred" | "deprecated";
  };
}

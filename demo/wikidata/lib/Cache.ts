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

import type { search_result, explore_result, def_result } from "..";
import type { w } from "./wiki_types.ts";

export class Cache {
  public back = () => {
    const fn = this.history.pop()!;
    fn();
  };

  public set = {
    search: (term: string, start: number, end: number, val: search_result) => {
      if (this.search_store[term]?.[start]?.[end]) return;
      this.search_store[term] = { [start]: { [end]: val } };
    },

    explore: (qid: string, val: explore_result) => {
      if (this.explore_store[qid]) return;
      this.explore_store[qid] = val;
    },

    definitions: (val: def_result) => {
      Object.entries(val).forEach(([id, res]) => {
        this.definitions_store[id] = res;
      });
    },

    history: (back: history_fn) => {
      this.history.push(back);
    },
  };

  public get = {
    search: (term: string, start: number, end: number) => {
      return this.search_store[term]?.[start]?.[end];
    },

    explore: (qid: string) => this.explore_store[qid],

    definitions: (ids: string[]) => {
      const entries: [string, w.frmtd.def][] = [];
      ids.forEach((id) => {
        const def = this.definitions_store[id];
        if (def) entries.push([id, def]);
      });
      return Object.fromEntries(entries);
    },

    history: () => this.history.length,
  };

  private search_store = {} as search_store;
  private explore_store = {} as explore_store;
  private definitions_store = {} as definitions_store;
  private history = [] as history_fn[];
}

type search_store = {
  [term: string]: { [start: number]: { [end: number]: search_result } };
};
type explore_store = { [qid: string]: explore_result };
type definitions_store = { [id: string]: w.frmtd.def };
type history_fn = () => void;

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

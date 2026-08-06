export class WikiApi {
  public search = (
    term: string,
    statements: string[] = [],
    limit: number = 5,
  ) => {
    const { headers, api } = this;
    const url = new URL(api.api);
    url.search = params();
    return new Request(url, { headers });

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
      }).toString();
    }
  };

  private api = {
    api: "https://www.wikidata.org/w/api.php",
    query: "https://query.wikidata.org/sparql",
    links: "https://www.wikidata.org/wiki/Special:EntityData",
    commons: "https://commons.wikimedia.org/w/index.php",
  };
  private headers = new Headers({
    "User-Agent":
      "fetchmanager/0.0 (https://github.com/citkane/fetchmanager/; noop@noop.com)",
  });
}

export namespace wiki {
  export namespace resp {
    export type search = {
      batchcomplete: string;
      continue: {
        sroffset: number;
        continue: string;
      };
      query: {
        searchinfo: {
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
  }
}

import { describe, expect, it } from "vitest";
import {
  TRACKING_PARAMETER_NAMES,
  TRACKING_PARAMETER_PREFIX,
  stripTrackingParams,
} from "./strip-tracking.js";
import { isSafeHttpUrl } from "./url.js";

describe("the tracker list", () => {
  it("is the utm_ prefix plus share ids and click ids", () => {
    expect(TRACKING_PARAMETER_PREFIX).toBe("utm_");
    expect([...TRACKING_PARAMETER_NAMES]).toContain("si");
    expect([...TRACKING_PARAMETER_NAMES]).toContain("gclid");
  });

  /*
   * Matching lowercases the name before the lookup, so an entry that is not
   * already lowercase could never be found — a silent no-op rather than a
   * failure. HubSpot spells one of these `hsCtaTracking`, which is exactly the
   * mistake this catches.
   */
  it("holds every name in lowercase, since lookups are lowercased", () => {
    for (const name of TRACKING_PARAMETER_NAMES) {
      expect(name).toBe(name.toLowerCase());
    }
  });

  /*
   * A name here that some site uses for real would strip links to the wrong
   * place. Generic words are the ones to keep out, however often they also
   * carry tracking.
   */
  it("holds no parameter a site might legitimately use", () => {
    for (const generic of ["ref", "tag", "source", "id", "q", "v", "t", "list", "page", "s"]) {
      expect(TRACKING_PARAMETER_NAMES.has(generic)).toBe(false);
    }
  });
});

describe("stripTrackingParams", () => {
  it("removes a utm_ parameter", () => {
    expect(stripTrackingParams("https://example.test/a?utm_source=newsletter")).toBe(
      "https://example.test/a"
    );
  });

  it.each(["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_anything"])(
    "removes %s",
    (name) => {
      expect(stripTrackingParams(`https://example.test/a?${name}=x&keep=1`)).toBe(
        "https://example.test/a?keep=1"
      );
    }
  );

  it("removes YouTube's share ids", () => {
    expect(stripTrackingParams("https://youtu.be/abc?si=xyz")).toBe("https://youtu.be/abc");
    expect(stripTrackingParams("https://example.test/a?is=xyz")).toBe("https://example.test/a");
  });

  /*
   * The reason for naming trackers instead of dropping the query: the rest of it
   * is where the link points. `v=` is which video and `t=` is where in it.
   */
  it("keeps the parameters that are the link", () => {
    expect(stripTrackingParams("https://youtube.com/watch?v=abc&t=120&si=xyz")).toBe(
      "https://youtube.com/watch?v=abc&t=120"
    );
    expect(stripTrackingParams("https://example.test/a?id=7&page=2&sort=desc")).toBe(
      "https://example.test/a?id=7&page=2&sort=desc"
    );
  });

  it("keeps the survivors in the order they arrived", () => {
    expect(stripTrackingParams("https://example.test/a?b=2&utm_source=x&a=1&si=y&c=3")).toBe(
      "https://example.test/a?b=2&a=1&c=3"
    );
  });

  /* A tracker is a tracker however the sharer's client capitalized it. */
  it("matches a name case-insensitively", () => {
    expect(stripTrackingParams("https://ex.test/p?UTM_SOURCE=x&SI=y")).toBe("https://ex.test/p");
    expect(stripTrackingParams("https://example.test/a?Utm_Campaign=x&Is=y&keep=1")).toBe(
      "https://example.test/a?keep=1"
    );
  });

  /* Only a whole name matches, so a parameter that merely contains one stays. */
  it("does not match a name it is only part of", () => {
    expect(stripTrackingParams("https://example.test/a?sid=7&isbn=9&basis=x&noutm_source=1")).toBe(
      "https://example.test/a?sid=7&isbn=9&basis=x&noutm_source=1"
    );
  });

  it("removes a valueless tracker, where the whole segment is the name", () => {
    expect(stripTrackingParams("https://example.test/a?utm_source&v=1")).toBe(
      "https://example.test/a?v=1"
    );
    expect(stripTrackingParams("https://example.test/a?si&v=1")).toBe("https://example.test/a?v=1");
  });

  it("removes a tracker written with an empty value", () => {
    expect(stripTrackingParams("https://example.test/a?utm_source=&v=1")).toBe(
      "https://example.test/a?v=1"
    );
  });

  /*
   * The whole reason the query is spliced rather than rebuilt: `URLSearchParams`
   * would hand back `q=a+b+c`, which is a different search than `a b c` was.
   */
  it("hands back the surviving text exactly as it arrived", () => {
    expect(stripTrackingParams("https://ex.test/p?q=a+b%20c&utm_medium=x")).toBe(
      "https://ex.test/p?q=a+b%20c"
    );
    expect(stripTrackingParams("https://ex.test/p?q=%26%3D%2F&utm_source=x")).toBe(
      "https://ex.test/p?q=%26%3D%2F"
    );
  });

  /* An encoded name is still the name it decodes to. */
  it("decodes a name before matching it", () => {
    expect(stripTrackingParams("https://example.test/a?%75tm_source=x&v=1")).toBe(
      "https://example.test/a?v=1"
    );
  });

  /*
   * A name that will not decode is not one of two short words or a four-letter
   * prefix, so the segment is kept rather than the throw being let out.
   */
  it("keeps a segment whose name is not decodable", () => {
    expect(stripTrackingParams("https://example.test/a?%zz=1&utm_source=x")).toBe(
      "https://example.test/a?%zz=1"
    );
    expect(stripTrackingParams("https://example.test/a?bad%=1")).toBe(
      "https://example.test/a?bad%=1"
    );
  });

  it("leaves a URL with no query alone", () => {
    expect(stripTrackingParams("https://example.test/a")).toBe("https://example.test/a");
    expect(stripTrackingParams("https://example.test")).toBe("https://example.test");
  });

  it("leaves a URL whose whole query is worth keeping alone", () => {
    expect(stripTrackingParams("https://example.test/a?v=abc&t=120#part-2")).toBe(
      "https://example.test/a?v=abc&t=120#part-2"
    );
  });

  /* A URL ending in a bare "?" is not the one that was pasted either. */
  it("removes the question mark when nothing survives", () => {
    expect(stripTrackingParams("https://x.test/p?utm_source=a")).toBe("https://x.test/p");
    expect(stripTrackingParams("https://x.test/p?utm_source=a&si=b")).toBe("https://x.test/p");
  });

  it("removes an empty query", () => {
    expect(stripTrackingParams("https://example.test/a?")).toBe("https://example.test/a");
  });

  it("keeps the fragment", () => {
    expect(stripTrackingParams("https://example.test/a#section-3")).toBe(
      "https://example.test/a#section-3"
    );
    expect(stripTrackingParams("https://ex.test/p?utm_source=news&page=2#part-3")).toBe(
      "https://ex.test/p?page=2#part-3"
    );
    expect(stripTrackingParams("https://example.test/a?utm_source=x#section-3")).toBe(
      "https://example.test/a#section-3"
    );
  });

  /* A "?" after the "#" belongs to the fragment, so there is no query to read. */
  it("leaves a question mark inside a fragment alone", () => {
    expect(stripTrackingParams("https://example.test/a#/route?utm_source=x")).toBe(
      "https://example.test/a#/route?utm_source=x"
    );
    expect(stripTrackingParams("https://example.test/a?utm_source=x#/route?tab=two")).toBe(
      "https://example.test/a#/route?tab=two"
    );
  });

  /*
   * Rejecting a URL is validation's job, not this function's. Handing back the
   * input unchanged is what lets the caller report why it was refused.
   */
  it("leaves something that is not a URL untouched", () => {
    expect(stripTrackingParams("not a url?utm_source=1")).toBe("not a url?utm_source=1");
    expect(stripTrackingParams("/relative/path?utm_source=1")).toBe("/relative/path?utm_source=1");
    expect(stripTrackingParams("")).toBe("");
  });

  /*
   * A dangerous scheme still parses, so it is stripped like anything else and
   * stays dangerous. Which schemes are allowed is `isSafeHttpUrl`'s decision,
   * and stripping neither makes a URL safe nor is a place to re-check it.
   */
  it("does not launder a javascript: URL", () => {
    expect(stripTrackingParams("javascript:alert(1)?utm_source=x")).toBe("javascript:alert(1)");
    expect(isSafeHttpUrl(stripTrackingParams("javascript:alert(1)?utm_source=x"))).toBe(false);
  });

  /*
   * `URL.toString()` would rewrite all of these. Stripping is not normalizing:
   * a URL that comes back different in ways nobody asked for is worse than one
   * that kept a parameter.
   */
  it.each([
    ["host case", "https://Example.TEST/a?utm_source=1", "https://Example.TEST/a"],
    ["path case", "https://example.test/A/B?utm_source=1", "https://example.test/A/B"],
    ["a default port", "https://example.test:443/a?utm_source=1", "https://example.test:443/a"],
    ["a missing trailing slash", "https://example.test?utm_source=1", "https://example.test"],
    ["a trailing slash", "https://example.test/a/?utm_source=1", "https://example.test/a/"],
    ["percent-encoding", "https://example.test/a%2Fb?utm_source=1", "https://example.test/a%2Fb"],
  ])("does not normalize %s", (_label, value, expected) => {
    expect(stripTrackingParams(value)).toBe(expected);
  });

  describe("the named trackers", () => {
    it.each([
      ["gclid", "https://ex.test/a?gclid=abc123", "https://ex.test/a"],
      ["fbclid", "https://ex.test/a?fbclid=IwAR0x", "https://ex.test/a"],
      ["msclkid", "https://ex.test/a?msclkid=9f", "https://ex.test/a"],
      ["igshid", "https://ex.test/a?igshid=MzR", "https://ex.test/a"],
      ["mc_eid", "https://ex.test/a?mc_cid=1&mc_eid=2", "https://ex.test/a"],
      ["mkt_tok", "https://ex.test/a?mkt_tok=eyJ", "https://ex.test/a"],
      ["_hsenc", "https://ex.test/a?_hsenc=p2A&_hsmi=8", "https://ex.test/a"],
      ["wbraid", "https://ex.test/a?wbraid=Ck8&gbraid=0AA", "https://ex.test/a"],
    ])("removes %s", (_name, value, expected) => {
      expect(stripTrackingParams(value)).toBe(expected);
    });

    it("removes a click id while leaving the rest of the query in place", () => {
      expect(stripTrackingParams("https://ex.test/a?page=2&gclid=abc&sort=new")).toBe(
        "https://ex.test/a?page=2&sort=new"
      );
    });

    /*
     * The blocklist only works while every name on it is meaningless to the page.
     * These are the parameters that carry the destination on sites people
     * actually paste from — the same ones link-cleaner restores by hand after
     * dropping the query wholesale. Any of them appearing above would mean this
     * strips links to somewhere other than where they pointed.
     */
    it.each([
      ["a YouTube video and timestamp", "https://youtube.com/watch?v=abc&t=120"],
      ["a YouTube playlist", "https://youtube.com/playlist?list=PL123"],
      ["a search query", "https://ex.test/search?q=rss+readers"],
      ["a Google Play app id", "https://play.google.com/store/apps/details?id=com.example"],
      ["a Facebook story", "https://www.facebook.com/story.php?story_fbid=1&id=2"],
      ["a Webtoon episode", "https://www.webtoons.com/ep?title_no=95&episode_no=3"],
      ["a paging cursor", "https://ex.test/a?page=4&per_page=50"],
    ])("keeps %s untouched", (_label, value) => {
      expect(stripTrackingParams(value)).toBe(value);
    });

    it("matches the names case-insensitively, as the prefix is", () => {
      expect(stripTrackingParams("https://ex.test/a?GCLID=x&FbClId=y")).toBe("https://ex.test/a");
    });

    /* A tracker is identified by name, so its value can be anything at all. */
    it("removes a tracker with an empty value or none", () => {
      expect(stripTrackingParams("https://ex.test/a?gclid=&keep=1")).toBe(
        "https://ex.test/a?keep=1"
      );
      expect(stripTrackingParams("https://ex.test/a?fbclid&keep=1")).toBe(
        "https://ex.test/a?keep=1"
      );
    });
  });

  it("leaves http URLs alone in the same way as https", () => {
    expect(stripTrackingParams("http://example.test/a?utm_source=1&x=2")).toBe(
      "http://example.test/a?x=2"
    );
  });
});

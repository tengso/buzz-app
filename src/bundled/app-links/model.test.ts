import { describe, expect, it } from "vitest";
import {
  type AppLink,
  appPath,
  MAX_LINKS,
  parseLinks,
  serializeLinks,
} from "./model";

const base = "https://gw.example/HaiChat/hti_research_team/#buzz=%7B%7D";
const link = (id: string, url = "/HaiChat/admin/"): AppLink => ({
  id,
  title: ` App ${id} `,
  url,
  trusted: false,
});

describe("app link model", () => {
  it("keeps addresses on this site's origin, as paths", () => {
    expect(appPath("/HaiChat/admin/", base)).toBe("/HaiChat/admin/");
    expect(appPath("../admin/?tab=1#top", base)).toBe(
      "/HaiChat/admin/?tab=1#top",
    );
    expect(appPath("https://gw.example/HaiChat/admin/", base)).toBe(
      "/HaiChat/admin/",
    );
    for (const refused of [
      "https://evil.example/HaiChat/admin/",
      "http://gw.example/HaiChat/admin/",
      "javascript:alert(1)",
      "data:text/html,<p>x</p>",
      "//evil.example/x",
    ])
      expect(() => appPath(refused, base)).toThrow(
        /Only addresses on gw\.example/,
      );
  });

  it("serializes validated lists and refuses invalid ones", () => {
    expect(JSON.parse(serializeLinks([link("a1")], base))).toEqual({
      version: 1,
      links: [
        { id: "a1", title: "App a1", url: "/HaiChat/admin/", trusted: false },
      ],
    });
    expect(() => serializeLinks([link("a1"), link("a1")], base)).toThrow(
      /Duplicate/,
    );
    expect(() => serializeLinks([{ ...link("a1"), title: " " }], base)).toThrow(
      /name/,
    );
    expect(() =>
      serializeLinks(
        Array.from({ length: MAX_LINKS + 1 }, (_, i) => link(`a${i}`)),
        base,
      ),
    ).toThrow(/at most/);
  });

  it("reads leniently, dropping entries this client cannot show", () => {
    const text = JSON.stringify({
      version: 1,
      links: [
        { id: "ok", title: "Admin", url: "/HaiChat/admin/", trusted: true },
        { id: "far", title: "Elsewhere", url: "https://evil.example/" },
        { id: "ok", title: "Duplicate", url: "/x/" },
        { id: "BAD ID", title: "Bad", url: "/x/" },
        null,
      ],
    });
    expect(parseLinks(text, base)).toEqual([
      { id: "ok", title: "Admin", url: "/HaiChat/admin/", trusted: true },
    ]);
    expect(() => parseLinks("{", base)).toThrow(/not valid/);
    expect(() => parseLinks('{"version":2,"links":[]}', base)).toThrow(
      /not valid/,
    );
  });
});

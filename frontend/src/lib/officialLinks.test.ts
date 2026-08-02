/* eslint-env jest */

import {
  OFFICIAL_B2B_SPECS_URL,
  OFFICIAL_CALENDAR_URL,
  OFFICIAL_PDP_LIST_URL,
  OFFICIAL_PDP_INFO_URL,
} from "./officialLinks";

const officialUrls = [OFFICIAL_CALENDAR_URL, OFFICIAL_B2B_SPECS_URL, OFFICIAL_PDP_LIST_URL, OFFICIAL_PDP_INFO_URL];

const httpsPattern = /^https:\/\/[^\s]+$/i;

type JestExpect = {
  toBe: (expected: unknown) => void;
  toBeTruthy: () => void;
  toContain: (expected: string) => void;
  not: { toContain: (expected: string) => void };
};

declare const describe: (name: string, fn: () => void) => void;
declare const it: (name: string, fn: () => void) => void;
declare const expect: (value: unknown) => JestExpect;

describe("officialLinks", () => {
  it("exports valid https URLs", () => {
    officialUrls.forEach((url) => {
      expect(httpsPattern.test(url)).toBe(true);
      const parsed = new URL(url);
      expect(parsed.protocol).toBe("https:");
    });
  });

  it("does not include placeholder strings", () => {
    officialUrls.forEach((url) => {
      const lower = url.toLowerCase();
      expect(lower).not.toContain("change_me");
      expect(lower).not.toContain("example");
    });
  });
});

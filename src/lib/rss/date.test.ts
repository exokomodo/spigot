import { describe, expect, it } from "vitest";
import { toRfc822 } from "./date.js";

describe("toRfc822", () => {
  it("formats the example from the RSS 2.0 specification", () => {
    expect(toRfc822(new Date(Date.UTC(2002, 9, 2, 13, 0, 0)))).toBe(
      "Wed, 02 Oct 2002 13:00:00 GMT"
    );
  });

  it("zero pads the day of the month", () => {
    expect(toRfc822(new Date(Date.UTC(2024, 0, 5, 0, 0, 0)))).toBe("Fri, 05 Jan 2024 00:00:00 GMT");
  });

  it("zero pads hours, minutes and seconds", () => {
    expect(toRfc822(new Date(Date.UTC(2024, 0, 5, 1, 2, 3)))).toBe("Fri, 05 Jan 2024 01:02:03 GMT");
  });

  it("uses a 24 hour clock", () => {
    expect(toRfc822(new Date(Date.UTC(2024, 6, 4, 23, 59, 59)))).toBe(
      "Thu, 04 Jul 2024 23:59:59 GMT"
    );
  });

  it("converts a non-UTC instant to GMT", () => {
    expect(toRfc822(new Date("2024-03-01T00:30:00-05:00"))).toBe("Fri, 01 Mar 2024 05:30:00 GMT");
  });

  it("rolls the date over when the local day differs from the UTC day", () => {
    expect(toRfc822(new Date("2024-12-31T20:00:00-05:00"))).toBe("Wed, 01 Jan 2025 01:00:00 GMT");
  });

  it("handles the leap day", () => {
    expect(toRfc822(new Date(Date.UTC(2024, 1, 29, 12, 0, 0)))).toBe(
      "Thu, 29 Feb 2024 12:00:00 GMT"
    );
  });

  it("formats the unix epoch", () => {
    expect(toRfc822(new Date(0))).toBe("Thu, 01 Jan 1970 00:00:00 GMT");
  });

  it("drops sub-second precision", () => {
    expect(toRfc822(new Date(Date.UTC(2024, 0, 1, 0, 0, 0, 999)))).toBe(
      "Mon, 01 Jan 2024 00:00:00 GMT"
    );
  });

  it("uses a four digit year", () => {
    expect(toRfc822(new Date(Date.UTC(999, 0, 1, 0, 0, 0)))).toMatch(/ 0999 /);
  });

  it("names every month correctly", () => {
    const months = Array.from({ length: 12 }, (_, month) =>
      toRfc822(new Date(Date.UTC(2021, month, 15, 0, 0, 0))).slice(8, 11)
    );
    expect(months).toEqual([
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ]);
  });

  it("names every weekday correctly", () => {
    // 2024-01-07 is a Sunday.
    const days = Array.from({ length: 7 }, (_, offset) =>
      toRfc822(new Date(Date.UTC(2024, 0, 7 + offset))).slice(0, 3)
    );
    expect(days).toEqual(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
  });

  it("rejects an invalid date", () => {
    expect(() => toRfc822(new Date("not a date"))).toThrow(RangeError);
  });
});

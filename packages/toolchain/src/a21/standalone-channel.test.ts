import { expect, test } from "bun:test";
import { STANDALONE_DEFAULT_CHANNEL, standaloneA21Channel, standaloneChannel } from "./standalone-channel";

test("standalone builds default to alpha 26", () => {
  expect(STANDALONE_DEFAULT_CHANNEL).toBe("alpha-26");
  expect(standaloneChannel({})).toBe("alpha-26");
  expect(standaloneChannel({ SPROUTBOAT_PORFFOR_CHANNEL: "" })).toBe("alpha-26");
  expect(standaloneChannel({ SPROUTBOAT_PORFFOR_CHANNEL: "alpha-26" })).toBe("alpha-26");
});

test("alpha 19 and 21 to 25 are errors that say so, not another alpha under their name", () => {
  for (const alpha of ["alpha-19", "alpha-21", "alpha-22", "alpha-23", "alpha-24", "alpha-25"])
    expect(() => standaloneChannel({ SPROUTBOAT_PORFFOR_CHANNEL: alpha })).toThrow(/no longer supported/);
});

test("the standalone channel renders with the current alpha", () => {
  expect(standaloneA21Channel("alpha-26")).toBe("alpha-26");
});

test("an unknown channel is an error, not a silent default", () => {
  expect(() => standaloneChannel({ SPROUTBOAT_PORFFOR_CHANNEL: "alpha-27" })).toThrow(/expected alpha-26/);
});

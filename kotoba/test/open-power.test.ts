import { describe, it, expect, beforeEach } from "vitest";
import { MockEtzhayyim } from "@etzhayyim/sdk-mock";
import {
  defineSubstation,
  getSubstation,
  listSubstations,
  defineFeeder,
  getFeeder,
  listFeeders,
  reportOutage,
  listOutages,
  coverage,
} from "../src/index.js";

describe("open-power kotoba", () => {
  let e: any;
  beforeEach(() => {
    e = new MockEtzhayyim({ did: "did:web:open-power.etzhayyim.com" });
  });

  describe("substation", () => {
    it("defines + gets + lists + rejects bad voltage class", async () => {
      expect((await defineSubstation(e, { substationId: "SS-1", name: "North", voltageKv: 66, voltageClass: "hv" })).status).toBe("defined");
      expect((await getSubstation(e, { substationId: "SS-1" })).substation?.voltageKv).toBe(66);
      expect((await listSubstations(e, { voltageClass: "hv" })).total).toBe(1);
      expect((await defineSubstation(e, { substationId: "SS-2", name: "x", voltageClass: "uhv" as any })).status).toBe("rejected");
    });
  });

  describe("feeder (refs substation)", () => {
    beforeEach(async () => {
      await defineSubstation(e, { substationId: "SS-1", name: "North" });
    });
    it("defines against existing substation; rejects missing", async () => {
      expect((await defineFeeder(e, { feederId: "F-1", substationId: "SS-1", serviceArea: "ward-3", ratedAmps: 400 })).status).toBe("defined");
      expect((await getFeeder(e, { feederId: "F-1" })).feeder?.ratedAmps).toBe(400);
      expect((await defineFeeder(e, { feederId: "F-2", substationId: "NOPE" })).status).toBe("substationNotFound");
    });
    it("lists by substation + status", async () => {
      await defineFeeder(e, { feederId: "F-1", substationId: "SS-1", status: "energized" });
      await defineFeeder(e, { feederId: "F-2", substationId: "SS-1", status: "fault" });
      expect((await listFeeders(e, { substationId: "SS-1" })).total).toBe(2);
      expect((await listFeeders(e, { status: "fault" })).total).toBe(1);
    });
  });

  describe("outage + coverage", () => {
    beforeEach(async () => {
      await defineSubstation(e, { substationId: "SS-1", name: "North" });
      await defineFeeder(e, { feederId: "F-1", substationId: "SS-1" });
    });
    it("reports against existing feeder; rejects bad cause/missing feeder", async () => {
      expect((await reportOutage(e, { outageId: "O-1", feederId: "F-1", cause: "weather", customersAffected: 1200 })).status).toBe("reported");
      expect((await reportOutage(e, { outageId: "O-2", feederId: "F-1", cause: "alien" as any })).status).toBe("rejected");
      expect((await reportOutage(e, { outageId: "O-3", feederId: "NOPE", cause: "equipment" })).status).toBe("feederNotFound");
    });
    it("filters outages + coverage rolls up active", async () => {
      await reportOutage(e, { outageId: "O-1", feederId: "F-1", cause: "weather" });
      await reportOutage(e, { outageId: "O-2", feederId: "F-1", cause: "vegetation" });
      expect((await listOutages(e, { cause: "weather" })).total).toBe(1);
      const cov = await coverage(e);
      expect(cov.substationCount).toBe(1);
      expect(cov.feederCount).toBe(1);
      expect(cov.outageCount).toBe(2);
      expect(cov.activeOutages).toBe(2);
    });
  });
});

/**
 * open-power kotoba — barrel.
 *
 * Per ADR-2605203000 Option B. Electric distribution grid registry on the
 * etzhayyim substrate (AT PDS records; no RW).
 *
 *   substation : defineSubstation / getSubstation / listSubstations
 *   feeder     : defineFeeder / getFeeder / listFeeders
 *   outage     : reportOutage / listOutages
 *   coverage   : grid rollup + active-outage count
 */

export * from "./types.js";
export {
  defineSubstation,
  getSubstation,
  listSubstations,
  defineFeeder,
  getFeeder,
  listFeeders,
  reportOutage,
  listOutages,
  coverage,
} from "./registry.js";

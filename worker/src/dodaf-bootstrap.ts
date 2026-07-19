// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 etzhayyim Japan株式会社 / etzhayyim. All rights reserved.
// Licensed under the Apache License, Version 2.0 — see LICENSE at repo root.

import OV1 from "../../dodaf/OV-1.json";
import OV5b from "../../dodaf/OV-5b.json";
import OV6a from "../../dodaf/OV-6a.json";
import CV2 from "../../dodaf/CV-2.json";
import SV1 from "../../dodaf/SV-1.json";
import AV1 from "../../dodaf/AV-1.json";
import defineFeederForm from "../../forms/defineFeeder.form.json";
import reportOutageForm from "../../forms/reportOutage.form.json";

export interface BootstrapEnv { PDS?: Fetcher; PRIMARY_DID: string; }

const FORMS = [defineFeederForm, reportOutageForm];
const DODAF_VIEWS = [AV1, OV1, OV5b, OV6a, CV2, SV1];

async function xrpc(pds: Fetcher, nsid: string, body: unknown): Promise<Response> {
  return pds.fetch(`https://atproto.etzhayyim.com/xrpc/${nsid}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

let bootstrapped = false;
export async function bootstrapDodaf(env: BootstrapEnv) {
  if (bootstrapped || !env.PDS) return { skipped: true };
  bootstrapped = true;
  const did = env.PRIMARY_DID;
  const errors: string[] = [];
  for (const view of DODAF_VIEWS) {
    try { await xrpc(env.PDS, "com.etzhayyim.dodafv2.deployView", { did, ...view }); }
    catch (e: any) { errors.push(`dodafv2.deployView ${(view as any).viewId}: ${e?.message}`); }
  }
  for (const f of FORMS) {
    try { await xrpc(env.PDS, "com.etzhayyim.form.register", { did, ...f }); }
    catch (e: any) { errors.push(`form.register ${(f as any).formKey}: ${e?.message}`); }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Hush facilitator for the API provider (role PROVIDER). The implementation lives in app.ts so the desk can run its
 * own instance in-process.
 *
 *   pnpm facilitator          (Fuji)   ·   pnpm facilitator:local
 */
import { PORTS } from "@hush/config";
import { createFacilitator } from "./app.js";

const facilitator = await createFacilitator();
facilitator.startJobs();
facilitator.listen(PORTS.facilitator);

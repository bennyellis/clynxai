import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { getEntitlementsForPlan } from "../entitlements/plans.js";

// The plan catalogue shown on the pricing page. Limits come from the same definitions the server enforces (entitlements/plans.ts), so the page cannot drift from the product.
// PRICES ARE NOT DEFINED HERE: they appear only when PLAN_PRICE_PRO_*_DISPLAY is set in the environment. Until the owner approves the plans the website shows a marked placeholder.

export async function plansRoutes(app: FastifyInstance): Promise<void> {
  app.get("/plans/public", async (_request, reply) => {
    reply.header("Cache-Control", "public, max-age=300");
    return reply.code(200).send({
      pricesApproved: !!(config.web.priceDisplay.proMonthly || config.web.priceDisplay.proYearly),
      trialDays: config.billing.trialDays,
      billingAvailable: config.billing.configured || config.billingFake,
      limitsEnforced: config.enforceEntitlements,
      plans: [
        { id: "free", name: "Free", price: { monthly: null, yearly: null }, entitlements: getEntitlementsForPlan("free") },
        {
          id: "pro",
          name: "Pro",
          price: { monthly: config.web.priceDisplay.proMonthly, yearly: config.web.priceDisplay.proYearly },
          intervals: { monthly: !!config.billing.priceProMonthly, yearly: !!config.billing.priceProYearly },
          entitlements: getEntitlementsForPlan("pro"),
        },
      ],
    });
  });
}

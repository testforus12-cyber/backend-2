// routes/dashboard.js
import express from "express";
const router = express.Router();

// Dev route: GET /api/dashboard/overview
router.get("/overview", (_req, res) => {
  res.json({
    totalShipments: 128,
    totalSpend: 560000,
    avgCostPerShipment: 4375,
    totalSavings: 48000,
    sampleCount: 5
  });
});

export default router;
